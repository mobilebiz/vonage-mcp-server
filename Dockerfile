# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Stage 2: Run
FROM node:22-slim

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Create directory for secrets (optional, but good practice)
RUN mkdir -p /secrets

# Environment variables (defaults)
ENV PORT=3000
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "dist/http-server.js"]
