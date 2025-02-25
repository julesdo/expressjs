FROM node:18-slim
RUN apt-get update && apt-get install -y imagemagick

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3333
CMD ["npm", "start"]
