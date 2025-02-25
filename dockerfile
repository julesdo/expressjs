# 1. Partir d'une image Node officielle (version 18, variante slim)
FROM node:18-slim

# 2. Installer ImageMagick
RUN apt-get update && apt-get install -y imagemagick && convert -version

# 3. Définir le dossier de travail
WORKDIR /app

# 4. Copier les fichiers de dépendances et installer
COPY package*.json ./
RUN npm install

# 5. Copier le reste du code
COPY . .

# 6. Compiler le code TypeScript
RUN npm run build

# 7. Exposer le port 3333 (ou autre)
EXPOSE 3333

# 8. Lancer l'application
CMD ["npm", "start"]
