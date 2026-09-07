FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY src ./src
COPY scripts ./scripts
COPY data ./data

ENV HOST=0.0.0.0 \
	PORT=5173

EXPOSE 5173

USER node

CMD ["npm", "run", "start"]
