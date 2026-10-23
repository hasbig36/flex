FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8080
RUN mkdir -p /data && chown node:node /data
# MikroTik builds pass RUN_AS=root: RouterOS creates mounted folders as root
ARG RUN_AS=node
USER ${RUN_AS}
CMD ["node", "src/server.js"]
