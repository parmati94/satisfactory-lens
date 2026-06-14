# ===== BUILDER STAGE =====
FROM node:20-slim AS builder

WORKDIR /app

# Build backend
COPY backend/package*.json ./backend/
RUN cd backend && npm ci

COPY backend/ ./backend/
RUN cd backend && npm run build

# Build frontend
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ===== RUNTIME STAGE =====
FROM node:20-slim

ARG DEV_MODE=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    supervisor \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend deps (all deps so tsx is available for dev mode too)
COPY backend/package*.json ./backend/
COPY backend/tsconfig.json ./backend/
RUN cd backend && npm ci

# Copy compiled backend from builder
COPY --from=builder /app/backend/dist ./backend/dist

# Copy built frontend
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy data directory (Phase 2: Docs.json etc.)
COPY data/ ./data/

# nginx config
COPY nginx.conf /etc/nginx/nginx.conf

# Supervisor configs — pick prod or dev based on build arg
COPY supervisor/supervisord.conf /tmp/supervisord.prod.conf
COPY supervisor/supervisord.dev.conf /tmp/supervisord.dev.conf
RUN if [ "$DEV_MODE" = "true" ]; then \
        cp /tmp/supervisord.dev.conf /etc/supervisor/conf.d/supervisord.conf; \
    else \
        cp /tmp/supervisord.prod.conf /etc/supervisor/conf.d/supervisord.conf; \
    fi

EXPOSE 80

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
