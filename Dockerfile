# --- Build stage ---
FROM node:22.18.0-alpine3.22 AS build

# 拉取 git 依赖必需；如有原生模块再加 python3 make g++
RUN apk add --no-cache git

WORKDIR /app

# 先拷贝依赖清单利用缓存
COPY package.json yarn.lock ./
# node:22 已自带 yarn 1.x，无需再 npm i -g yarn
RUN yarn install --frozen-lockfile

# 再拷贝源码并构建
COPY . .
RUN yarn build

# --- Runtime stage ---
# The lightweight Node server serves the built UI and wraps /sub so TLS-enabled
# SOCKS5 fields can be restored after the upstream converter has done its work.
FROM node:22.18.0-alpine3.22

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=build /app/dist ./dist
COPY server ./server

ENV PORT=80 \
    SUBCONVERTER_UPSTREAM=https://api.v1.mk

EXPOSE 80
CMD ["node", "server/index.js"]
