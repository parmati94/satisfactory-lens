# ===== BUILDER STAGE =====
FROM node:20-slim AS builder

WORKDIR /app

# Build backend
COPY backend/package*.json ./backend/
RUN cd backend && npm ci

COPY backend/ ./backend/
RUN cd backend && npm run build

# Generate map tiles from committed source image
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir Pillow --break-system-packages
COPY scripts/slice_map.py ./scripts/
COPY frontend/public/img/map_16k.jpg ./frontend/public/img/
RUN python3 scripts/slice_map.py

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

# Copy static data files used at runtime
COPY backend/data/ ./backend/data/

# Copy built frontend
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy generated map tiles
COPY --from=builder /app/frontend/public/tiles /usr/share/nginx/html/tiles

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
