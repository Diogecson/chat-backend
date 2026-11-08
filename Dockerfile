FROM node:20-alpine

WORKDIR /app

# Instala deps primeiro (cache de layer)
COPY package*.json ./
RUN npm install --omit=dev --production

# Copia código + estáticos
COPY src ./src
COPY public ./public

# Variável de ambiente só expõe a porta — resto vem do EasyPanel
EXPOSE 3100

# Default: sobe a API. Pra worker/cron, override com CMD no EasyPanel.
CMD ["node", "src/server.js"]
