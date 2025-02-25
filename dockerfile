# 1. Partir d'une image Node officielle (version 18, variante slim)
FROM node:18-slim

# 2. Installer ImageMagick
RUN apt-get update && apt-get install -y imagemagick

# 3. Définir le dossier de travail
WORKDIR /app

# 4. Copier les fichiers de dépendances et installer
COPY package*.json ./
RUN npm install

# 5. Copier le reste du code
COPY . .

# 6. Compiler le code TypeScript (si vous avez un script "build" dans package.json)
RUN npm run build

# 7. Exposer le port (3000 si votre serveur écoute sur 3000)
EXPOSE 3000

# 8. Lancer l'application
#    Assurez-vous que votre script "start" (dans package.json) exécute "node dist/index.js" ou "node dist/server.js"
CMD ["npm", "start"]
