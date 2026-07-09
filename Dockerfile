FROM node:22.14.0-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8788

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./

EXPOSE 8788

CMD ["node", "src/server.js"]
