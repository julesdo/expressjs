# 1. Partir d'une image Node officielle (version 18, variante slim)
FROM node:18-slim

# 2. Installer ImageMagick (pour vos traitements d'image)
RUN apt-get update && apt-get install -y imagemagick

# 3. Définir le dossier de travail
WORKDIR /app

# 4. Copier les fichiers de dépendances et installer
COPY package*.json ./
RUN npm install

# 5. Copier le reste du code (src, tsconfig, etc.)
COPY . .

# 6. Compiler le code TypeScript
RUN npm run build && ls -l dist

# 7. Exposer le port 3333 (celui que vous utilisez dans index.ts)
EXPOSE 3333

# 8. Lancer l'application (script "start" => "node dist/index.js")
CMD ["npm", "start"]
