FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV HOST=0.0.0.0 PORT=8006 DATA_DIR=/app/var
RUN mkdir /app/var && chown -R node:node /app
USER node
EXPOSE 8006
CMD ["node", "src/server.ts"]
