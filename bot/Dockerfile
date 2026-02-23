# Use a Node.js version that matches your dependencies (e.g., Node 20)
FROM node:20-slim

# Install ffmpeg AND the tools required to build native addons
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set a root working directory
WORKDIR /usr/src/app

# Copy the shared directory FIRST so it resolves correctly via relative imports
COPY shared ./shared

# Set the working directory for the bot
WORKDIR /usr/src/app/bot

# Copy package.json and package-lock.json from the bot directory
COPY bot/package*.json ./

# Install app dependencies
RUN npm ci

# Copy the rest of your bot's source code
COPY bot/ ./

# Run the build script to compile TypeScript to JavaScript
RUN npm run build

# Your app's start command (from package.json)
CMD [ "npm", "run", "start" ]