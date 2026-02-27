import { Telegraf } from 'telegraf';
import { eq, and } from 'drizzle-orm';
import { db } from '../services/database';
import { trailingStopOrders } from '../../../shared/schema';
import logger from '../services/logger';
import { getCurrentPrice, getMultiplePrices } from '../services/price-monitor';
import { createQuote, createOrder } from '../services/sideshift-client';

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

export class TrailingStopWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private bot: Telegraf | null = null;

  constructor() {
    // Constructor - no initialization needed
  }

  public async start(bot: Telegraf) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.bot = bot;

    logger.info('🚀 Starting Trailing Stop Worker...');

    // Run immediately
    this.checkTrailingStops();

    // Schedule periodic checks
    this.intervalId = setInterval(() => {
      this.checkTrailingStops();
    }, CHECK_INTERVAL_MS);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('🛑 Trailing Stop Worker stopped.');
  }

  /**
   * Check all active trailing stop orders and update/process them
   */
  private async checkTrailingStops() {
    try {
      // Fetch active trailing stop orders
      const activeOrders = await db.select().from(trailingStopOrders)
        .where(and(
          eq(trailingStopOrders.isActive, true),
          eq(trailingStopOrders.status, 'pending')
        ));

      if (activeOrders.length === 0) return;

      logger.info(`🔍 Checking ${activeOrders.length} active trailing stop orders...`);

      // Get unique assets to fetch prices for
      const assetsToFetch = new Set<string>();
      for (const order of activeOrders) {
        assetsToFetch.add(order.fromAsset.toUpperCase());
      }

      // Fetch current prices
      const prices = await getMultiplePrices(Array.from(assetsToFetch));

      // Process each order
      for (const order of activeOrders) {
        const currentPrice = prices[order.fromAsset.toUpperCase()];

        if (currentPrice === null) {
          logger.warn(`⚠️ No price found for ${order.fromAsset}, skipping order ${order.id}`);
          continue;
        }

        await this.processTrailingStopOrder(order, currentPrice);


      }

    } catch (error) {
      logger.error('❌ Error in Trailing Stop Worker loop:', error);
    }
  }

  /**
   * Process a single trailing stop order
   */
  private async processTrailingStopOrder(order: typeof trailingStopOrders.$inferSelect, currentPrice: number) {
    try {
      const currentPriceNum = currentPrice;
      const trailingPercentage = order.trailingPercentage;
      
      // Initialize peak price if not set
      let peakPrice = order.peakPrice ? parseFloat(order.peakPrice.toString()) : currentPriceNum;
      
      // Update peak price if current price is higher
      if (currentPriceNum > peakPrice) {
        peakPrice = currentPriceNum;
        logger.info(`📈 New peak price for order ${order.id}: $${peakPrice}`);
      }

      // Calculate trigger price
      const triggerPrice = peakPrice * (1 - trailingPercentage / 100);

      // Update order with current values
      await db.update(trailingStopOrders)
        .set({
          peakPrice: peakPrice.toString(),
          currentPrice: currentPriceNum.toString(),
          triggerPrice: triggerPrice.toString(),
          lastCheckedAt: new Date(),
        })
        .where(eq(trailingStopOrders.id, order.id));

      // Check if trigger condition is met
      if (currentPriceNum <= triggerPrice) {
        logger.info(`🚨 Trailing stop triggered for order ${order.id}! Current: $${currentPriceNum}, Peak: $${peakPrice}, Trigger: $${triggerPrice}`);
        await this.triggerTrailingStop(order, currentPriceNum, peakPrice, triggerPrice);
      }

    } catch (error) {
      logger.error(`❌ Error processing trailing stop order ${order.id}:`, error);
    }
  }

  /**
   * Trigger a trailing stop order (execute the swap)
   */
  private async triggerTrailingStop(
    order: typeof trailingStopOrders.$inferSelect, 
    currentPrice: number, 
    peakPrice: number, 
    triggerPrice: number
  ) {
    try {
      // Update order status to triggered
      await db.update(trailingStopOrders)
        .set({
          status: 'triggered',
          isActive: false,
          triggeredAt: new Date(),
        })
        .where(eq(trailingStopOrders.id, order.id));

      // Notify user
      const message = `🚨 *Trailing Stop Triggered!*\n\n` +
        `*${order.fromAsset} → ${order.toAsset}*\n` +
        `Amount: ${order.fromAmount} ${order.fromAsset}\n` +
        `Peak Price: $${peakPrice.toLocaleString()}\n` +
        `Current Price: $${currentPrice.toLocaleString()}\n` +
        `Trigger Price: $${triggerPrice.toLocaleString()}\n` +
        `Trailing: ${order.trailingPercentage}%\n\n` +
        `Executing swap now...`;

      if (this.bot && order.telegramId) {
        await this.bot.telegram.sendMessage(Number(order.telegramId), message, { parse_mode: 'Markdown' });
      }

      // Execute the swap
      await this.executeSwap(order);

    } catch (error) {
      logger.error(`❌ Error triggering trailing stop order ${order.id}:`, error);
      
      // Update order with error
      await db.update(trailingStopOrders)
        .set({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        .where(eq(trailingStopOrders.id, order.id));
    }
  }

  /**
   * Execute the actual swap via SideShift
   */
  private async executeSwap(order: typeof trailingStopOrders.$inferSelect) {
    try {
      if (!order.settleAddress) {
        throw new Error('No settle address provided');
      }

      // Create quote
      const quote = await createQuote(
        order.fromAsset,
        order.fromNetwork || 'ethereum',
        order.toAsset,
        order.toNetwork || 'ethereum',
        parseFloat(order.fromAmount),
        process.env.SIDESHIFT_CLIENT_IP || '127.0.0.1'
      );


      if (quote.error) {
        throw new Error(`Quote error: ${quote.error.message}`);
      }

      // Create order
      const sideshiftOrder = await createOrder(quote.id, order.settleAddress, order.settleAddress);

      if (!sideshiftOrder.id) {
        throw new Error('Failed to create SideShift order');
      }

      // Update order with sideshift order ID
      await db.update(trailingStopOrders)
        .set({
          status: 'completed',
          sideshiftOrderId: sideshiftOrder.id,
        })
        .where(eq(trailingStopOrders.id, order.id));

      // Notify user of success
      const successMessage = `✅ *Trailing Stop Executed!*\n\n` +
        `Order ID: \`${sideshiftOrder.id}\`\n` +
        `Deposit: ${quote.depositAmount} ${quote.depositCoin} to \`${sideshiftOrder.depositAddress}\`\n` +
        `Receive: ${sideshiftOrder.settleAmount} ${sideshiftOrder.settleCoin}\n\n` +
        `Please complete the transaction by sending funds to the deposit address.`;


      if (this.bot && order.telegramId) {
        await this.bot.telegram.sendMessage(Number(order.telegramId), successMessage, { parse_mode: 'Markdown' });
      }

      logger.info(`✅ Trailing stop order ${order.id} executed successfully. SideShift Order: ${sideshiftOrder.id}`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`❌ Error executing swap for trailing stop order ${order.id}:`, error);

      // Update order with error
      await db.update(trailingStopOrders)
        .set({
          status: 'failed',
          error: errorMessage,
        })
        .where(eq(trailingStopOrders.id, order.id));

      // Notify user of failure
      const failureMessage = `❌ *Trailing Stop Failed*\n\n` +
        `Error: ${errorMessage}\n\n` +
        `Your trailing stop order has been marked as failed. Please create a new order if needed.`;

      if (this.bot && order.telegramId) {
        await this.bot.telegram.sendMessage(Number(order.telegramId), failureMessage, { parse_mode: 'Markdown' });
      }
    }
  }

  /**
   * Create a new trailing stop order
   */
  public async createTrailingStopOrder(data: {
    telegramId?: number;
    userId?: string;
    fromAsset: string;
    fromNetwork: string;
    toAsset: string;
    toNetwork: string;
    fromAmount: string;
    trailingPercentage: number;
    settleAddress: string;
    expiresAt?: Date;
  }): Promise<typeof trailingStopOrders.$inferSelect> {
    // Get current price to set initial peak
    const currentPrice = await getCurrentPrice(data.fromAsset);
    const peakPrice = currentPrice || 0;

    // Calculate initial trigger price
    const triggerPrice = peakPrice * (1 - data.trailingPercentage / 100);

    const [order] = await db.insert(trailingStopOrders).values({
      telegramId: data.telegramId,
      userId: data.userId,
      fromAsset: data.fromAsset,
      fromNetwork: data.fromNetwork,
      toAsset: data.toAsset,
      toNetwork: data.toNetwork,
      fromAmount: data.fromAmount,
      trailingPercentage: data.trailingPercentage,
      peakPrice: peakPrice.toString(),
      currentPrice: peakPrice.toString(),
      triggerPrice: triggerPrice.toString(),
      settleAddress: data.settleAddress,
      expiresAt: data.expiresAt,
      isActive: true,
      status: 'pending',
      createdAt: new Date(),
      lastCheckedAt: new Date(),
    }).returning();

    logger.info(`✅ Created trailing stop order ${order.id} for ${data.fromAsset} with ${data.trailingPercentage}% trailing stop`);

    return order;
  }

  /**
   * Cancel a trailing stop order
   */
  public async cancelTrailingStopOrder(orderId: number, userId: number | string): Promise<boolean> {
    try {
      const [order] = await db.select().from(trailingStopOrders)
        .where(eq(trailingStopOrders.id, orderId))
        .limit(1);

      if (!order) {
        return false;
      }

      // Verify ownership
      if (order.telegramId !== userId && order.userId !== userId.toString()) {
        return false;
      }

      await db.update(trailingStopOrders)
        .set({
          status: 'cancelled',
          isActive: false,
        })
        .where(eq(trailingStopOrders.id, orderId));

      logger.info(`🚫 Cancelled trailing stop order ${orderId}`);
      return true;

    } catch (error) {
      logger.error(`❌ Error cancelling trailing stop order ${orderId}:`, error);
      return false;
    }
  }

  /**
   * Get all trailing stop orders for a user
   */
  public async getUserTrailingStops(userId: number | string): Promise<(typeof trailingStopOrders.$inferSelect)[]> {
    const id = typeof userId === 'number' ? userId : null;
    const idStr = typeof userId === 'string' ? userId : null;

    if (id) {
      return await db.select().from(trailingStopOrders)
        .where(eq(trailingStopOrders.telegramId, id));
    } else if (idStr) {
      return await db.select().from(trailingStopOrders)
        .where(eq(trailingStopOrders.userId, idStr));
    }

    return [];
  }
}

export const trailingStopWorker = new TrailingStopWorker();
