# Use Node.js LTS
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Create non-root user
RUN addgroup -g 1001 -S botuser && \
    adduser -S -u 1001 -G botuser botuser && \
    chown -R botuser:botuser /app

# Switch to non-root user
USER botuser

# Health check (optional)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Start the bot
CMD ["node", "dist/index.js"]
