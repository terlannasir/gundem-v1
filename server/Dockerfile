FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
COPY web ./web
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.js"]
