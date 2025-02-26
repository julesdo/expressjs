// server.ts

import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Bull, { Job } from 'bull';

// **** NOUVEAU : pour exécuter ImageMagick via des commandes shell ****
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);

// ---------- Middleware pour conserver le body brut ----------
const rawBodySaver = (
  req: Request,
  res: Response,
  buf: Buffer,
  encoding: string
) => {
  (req as any).rawBody = buf;
};

const app = express();
app.use(bodyParser.json({ verify: rawBodySaver }));

// ---------- Variables d'environnement ----------
const SHOPIFY_WEBHOOK_SECRET: string = process.env.SHOPIFY_WEBHOOK_SECRET!;
if (!SHOPIFY_WEBHOOK_SECRET) {
  throw new Error('SHOPIFY_WEBHOOK_SECRET is not defined');
}

const PORT: number = parseInt(process.env.PORT || '3000', 10);

const redisHost: string = process.env.REDIS_HOST || '127.0.0.1';
const redisPort: number = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword: string | undefined = process.env.REDIS_PASSWORD;

// ---------- Configuration de la file d'attente Bull ----------
const webhookQueue = new Bull('shopify-webhook', {
  redis: {
    host: redisHost,
    port: redisPort,
    password: redisPassword
  }
});

// ---------- Verrouillage en mémoire (pour une instance) ----------
const locks: Map<string, boolean> = new Map();

// ---------- Interfaces & Types ----------
interface CompositeOptions {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface DerivedProductDefinition {
  name: string;
  description: string;
  template: string;
  compositeOptions: CompositeOptions;
  variants?: Array<{ option: string; price: string; skuSuffix?: string }>;
  price?: string;
  collections?: string[];
}

interface ShopifyProductImage {
  attachment: string;
}

interface ShopifyProduct {
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  images: ShopifyProductImage[];
  tags: string[];
  options?: Array<{ name: string }>;
  variants?: Array<{ option1: string; price: string; sku: string }>;
  published_at: string;
  published_scope: string;
  status: string;
}

interface GenerateDerivativesPayload {
  artworkId: string;
  artworkTitle: string;
  artworkDescription: string;
  artworkImageUrl: string;
  createDerivatives: boolean;
}

// Interfaces pour les réponses de Shopify pour collections
interface CustomCollectionsResponse {
  custom_collections: { id: number }[];
}

interface SmartCollectionsResponse {
  smart_collections: { id: number }[];
}

// ---------- Configuration des produits dérivés ----------
const positioningConfig: { [key: string]: CompositeOptions } = {
  'grand-sac-de-plage': { top: 524, left: 327, width: 264, height: 265 },
  'coque-de-telephone': { top: 50, left: 30, width: 200, height: 200 },
  'tote-bag': { top: 522, left: 321, width: 309, height: 310 },
  'tee-shirt-homme': { top: 164, left: 291, width: 329, height: 330 },
  'tee-shirt-femme': { top: 321, left: 312, width: 340, height: 341 },
  sweatshirt: { top: 216, left: 318, width: 336, height: 337 },
  plexiglas: { top: 49, left: 317, width: 228, height: 320 }
};

const derivedProductDefinitions: DerivedProductDefinition[] = [
  {
    name: 'Les Oeuvres sur Plexiglas',
    description: `• Trois formats disponibles<br>
    • Acrylique brillant transparent de 3 mm<br>
    • Trous pré-percés, entretoises et languettes adhésives disponibles<br>
    • Impression en couleur de qualité<br><br>
    Remarque : Chaque impression est protégée par un film vert détachable. Retirez-le avant l’affichage.<br>
    À la recherche d’une décoration murale originale ? Le plexiglas met en valeur les couleurs pour un rendu réaliste et vibrant.`,
    template: path.join(process.cwd(), 'public', 'templates', 'plexiglas.png'),
    compositeOptions: positioningConfig['plexiglas'] || {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    variants: [
      { option: '40X30', price: '100.00', skuSuffix: '40x30' },
      { option: '60X40', price: '180.00', skuSuffix: '60x40' },
      { option: '90X60', price: '250.00', skuSuffix: '90x60' }
    ],
    price: '100.00',
    collections: ['Boutique', 'Œuvres plexiglas', 'Décorations']
  },
  {
    name: 'Le Sac fourre-tout Deluxe en coton',
    description: `Toile 100 % coton, 320 g/m²<br>
    Dimensions : 38 cm H x 47 cm L x 12 cm P<br>
    Longueur des anses : 26 cm`,
    template: path.join(process.cwd(), 'public', 'templates', 'tote-bag.png'),
    compositeOptions: positioningConfig['tote-bag'] || {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    price: '30.00',
    collections: ['Boutique', 'Sacs', 'Accessoires']
  },
  {
    name: 'Le Tee Shirt HOMME',
    description: `Manches courtes / Blanc<br>
    Tailles : S, M, L, XL<br>
    100 % coton léger (Blanc), 99 % coton, 1 % polyester (gris cendré), 97 % coton, 3 % polyester (gris chiné)<br>
    Coutures doubles pour une résistance accrue`,
    template: path.join(
      process.cwd(),
      'public',
      'templates',
      'tee-shirt-homme.png'
    ),
    compositeOptions: positioningConfig['tee-shirt-homme'] || {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    variants: [
      { option: 'S', price: '40.00' },
      { option: 'M', price: '40.00' },
      { option: 'L', price: '40.00' },
      { option: 'XL', price: '40.00' }
    ],
    price: '40.00',
    collections: ['Boutique', 'Vêtements', 'Hommes', 'Tee-shirts']
  },
  {
    name: 'Le Tee Shirt Femme',
    description: `Manches courtes / Blanc<br>
        Tailles : S, M, L, XL<br>
        100 % coton léger (Blanc), 99 % coton, 1 % polyester (gris cendré), 97 % coton, 3 % polyester (gris chiné)<br>
        Coutures doubles pour une résistance accrue`,
    template: path.join(
      process.cwd(),
      'public',
      'templates',
      'tee-shirt-femme.png'
    ),
    compositeOptions: positioningConfig['tee-shirt-femme'] || {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    variants: [
      { option: 'XS', price: '40.00' },
      { option: 'S', price: '40.00' },
      { option: 'M', price: '40.00' },
      { option: 'L', price: '40.00' }
    ],
    price: '40.00',
    collections: ['Boutique', 'Vêtements', 'Femmes', 'Tee-shirts']
  },
  {
    name: 'Le Grand Sac de Plage',
    description: `Disponible en Noir ou Blanc`,
    template: path.join(
      process.cwd(),
      'public',
      'templates',
      'grand-sac-de-plage.png'
    ),
    compositeOptions: positioningConfig['grand-sac-de-plage'] || {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    variants: [
      { option: 'Noir', price: '45.00' },
      { option: 'Blanc', price: '45.00' }
    ],
    price: '45.00',
    collections: ['Boutique', 'Sacs', 'Accessoires']
  },
  {
    name: 'Le Sweat Shirt à Capuche Unisexe',
    description: `Mélange léger 80 % coton et 20 % polyester, 280 g/m²<br>
    Coupe Regular<br>
    Capuche avec cordon de serrage<br>
    Poche avant kangourou<br>
    Disponible en Blanc, Noir et Bleu Marine<br>
    Tailles : S, M, L, XL`,
    template: path.join(
      process.cwd(),
      'public',
      'templates',
      'sweatshirt-bleumarine.png'
    ),
    compositeOptions: positioningConfig['sweatshirt'] || {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    collections: ['Boutique', 'Vêtements', 'Hommes', 'Femmes', 'Sweatshirts'],
    variants: (() => {
      const colors = ['Blanc', 'Noir', 'Bleu Marine'];
      const sizes = ['S', 'M', 'L', 'XL'];
      const vars: Array<{ option: string; price: string; skuSuffix?: string }> =
        [];
      for (const color of colors) {
        for (const size of sizes) {
          vars.push({
            option: `${color} - ${size}`,
            price: '75.00',
            skuSuffix: `${color}-${size}`.replace(/\s+/g, '').toLowerCase()
          });
        }
      }
      return vars;
    })()
  },
  {
    name: 'Coque de téléphone',
    description: `Coque dérivée de l’œuvre. Prix fixe.<br>
      Pour personnaliser, veuillez renseigner votre modèle lors de la commande.`,
    template: path.join(
      process.cwd(),
      'public',
      'templates',
      'phone',
      'generic-phone.png'
    ),
    compositeOptions: positioningConfig['coque-de-telephone'] || {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    collections: ['Boutique', 'Accessoires', 'Coques de protection'],
    variants: (() => {
      const phoneModels = [
        'iPhone 16 Plus',
        'iPhone 16',
        'iPhone 16e',
        'iPhone 15',
        'iPhone 14 Pro Max',
        'iPhone 14 Pro',
        'iPhone 14',
        'iPhone 13 Pro Max',
        'iPhone 13 Pro',
        'iPhone 13',
        'iPhone 12 Pro Max',
        'iPhone 12 Pro',
        'iPhone 12',
        'Samsung Galaxy S23 Ultra',
        'Samsung Galaxy S23',
        'Samsung Galaxy S22',
        'Google Pixel 7 Pro',
        'Google Pixel 7',
        'Google Pixel 6',
        'Autre (préciser le modèle en commentaire)'
      ];
      return phoneModels.map((model) => ({
        option: model, // correspond à 'option1' plus loin
        price: '29.99',
        skuSuffix: model.replace(/\s+/g, '').toLowerCase()
      }));
    })()
  },
  // coque de pc portable
  {
    name: 'Coque de PC Portable',
    description: `Coque dérivée de l’œuvre. Prix fixe.<br>
    Matière : Plastique<br>
    Étanche<br>
    Filtre UV<br>
    Facile à poser<br>
    Adhésif micro-canaux qui élimine les bulles d’air lorsqu’il est posé<br>
      Pour personnaliser, veuillez renseigner votre modèle lors de la commande.`,
    template: path.join(
      process.cwd(),
      'public',
      'templates',
      'phone',
      'generic-phone.png'
    ),
    compositeOptions: {
      top: 0,
      left: 0,
      width: 500,
      height: 500
    },
    collections: ['Boutique', 'Accessoires', 'Coques de protection'],
    variants: (() => {
      const laptopModels = [
        'MacBook Air 13 pouces',
        'MacBook Air 15 pouces',
        'MacBook Pro 13 pouces',
        'MacBook Pro 15 pouces',
        'MacBook Pro 16 pouces',
        'Dell XPS 13',
        'Dell XPS 15',
        'HP Spectre x360',
        'Lenovo ThinkPad X1 Carbon',
        'Autre (préciser le modèle en commentaire)'
      ];
      return laptopModels.map((model) => ({
        option: model,
        price: '60.00',
        skuSuffix: model.replace(/\s+/g, '').toLowerCase()
      }));
    })()
  }
];

// ---------- Fonctions Utilitaires ----------
async function getCollectionIdByName(
  collectionName: string
): Promise<string | null> {
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;

  // Custom collections
  const url: string = `${shopifyAdminDomain}/custom_collections.json?title=${encodeURIComponent(
    collectionName
  )}`;
  let res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': shopifyAdminToken }
  });
  if (res.ok) {
    const data = (await res.json()) as CustomCollectionsResponse;
    if (data.custom_collections && data.custom_collections.length > 0) {
      return data.custom_collections[0].id.toString();
    }
  } else {
    console.error(
      `Erreur lors de la récupération de la collection "${collectionName}" : ${res.statusText}`
    );
  }

  // Smart collections
  const smartUrl: string = `${shopifyAdminDomain}/smart_collections.json?title=${encodeURIComponent(
    collectionName
  )}`;
  res = await fetch(smartUrl, {
    headers: { 'X-Shopify-Access-Token': shopifyAdminToken }
  });
  if (res.ok) {
    const smartData = (await res.json()) as SmartCollectionsResponse;
    if (smartData.smart_collections && smartData.smart_collections.length > 0) {
      return smartData.smart_collections[0].id.toString();
    }
  } else {
    console.error(
      `Erreur lors de la récupération de la smart collection "${collectionName}" : ${res.statusText}`
    );
  }

  return null;
}

async function addProductToCollectionsByNames(
  productId: string,
  collectionNames: string[]
): Promise<void> {
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  for (const collectionName of collectionNames) {
    const collectionId = await getCollectionIdByName(collectionName);
    if (collectionId) {
      const url: string = `${shopifyAdminDomain}/collects.json`;
      const body = {
        collect: { product_id: productId, collection_id: collectionId }
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': shopifyAdminToken
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        console.error(
          `Erreur lors de l'association du produit ${productId} à la collection "${collectionName}": ${await res.text()}`
        );
      }
    } else {
      console.error(`Collection "${collectionName}" introuvable.`);
    }
  }
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Erreur lors du téléchargement de l’image: ${res.statusText}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Génère un mockup plus réaliste en utilisant ImageMagick :
 * 1. Écrit le template et l’œuvre dans des fichiers temporaires.
 * 2. Redimensionne l’œuvre.
 * 3. Compose l’œuvre sur le template avec un mode de fusion.
 * 4. Retourne l'image finale en Buffer.
 */
async function generateMockup(
  artworkBuffer: Buffer,
  compositeOptions: CompositeOptions,
  templatePath: string
): Promise<Buffer> {
  // Préparation de chemins temporaires
  const uniqueId = uuidv4();
  const tmpDir = os.tmpdir();

  const artworkInputPath = path.join(tmpDir, `artwork-${uniqueId}.png`);
  const templateInputPath = path.join(tmpDir, `template-${uniqueId}.png`);
  const artworkResizedPath = path.join(
    tmpDir,
    `artwork-resized-${uniqueId}.png`
  );
  const outputPath = path.join(tmpDir, `output-${uniqueId}.png`);

  // Lecture du template depuis le disque
  const templateBuffer = await fs.readFile(templatePath);

  // Écriture des fichiers temporaires
  await fs.writeFile(artworkInputPath, artworkBuffer);
  await fs.writeFile(templateInputPath, templateBuffer);

  // Redimensionnement de l'œuvre
  const resizeCmd = `convert "${artworkInputPath}" \
  -resize ${compositeOptions.width}x${compositeOptions.height}^ \
  -gravity center \
  -extent ${compositeOptions.width}x${compositeOptions.height} \
  "${artworkResizedPath}"`;
  await execAsync(resizeCmd);

  // Composition
  const compositeCmd = `composite -gravity Northwest -geometry +${compositeOptions.left}+${compositeOptions.top} \
    "${artworkResizedPath}" "${templateInputPath}" "${outputPath}"`;
  await execAsync(compositeCmd);

  // Lecture du résultat final
  const finalBuffer = await fs.readFile(outputPath);

  // Nettoyage
  try {
    await fs.unlink(artworkInputPath);
    await fs.unlink(templateInputPath);
    await fs.unlink(artworkResizedPath);
    await fs.unlink(outputPath);
  } catch (err) {
    console.warn('Impossible de supprimer un fichier temporaire :', err);
  }

  return finalBuffer;
}

async function createShopifyProduct(productData: ShopifyProduct): Promise<any> {
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  const idempotencyKey: string = crypto
    .createHash('sha256')
    .update(productData.title)
    .digest('hex');
  const url: string = `${shopifyAdminDomain}/products.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAdminToken,
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({ product: productData })
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Erreur Shopify API: ${res.status} ${res.statusText} - ${errorText}`
    );
  }
  return res.json();
}

async function derivativeExists(
  artworkTitle: string,
  derivativeName: string
): Promise<boolean> {
  const shopifyStoreDomainUrl: string = process.env.SHOPIFY_STORE_DOMAIN_URL!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  const fullTitle: string = `${artworkTitle} - ${derivativeName}`;
  const query: string = `
    {
      products(first: 1, query: "title:'${fullTitle}'") {
        edges {
          node { id }
        }
      }
    }
  `;
  const url: string = `${shopifyStoreDomainUrl}/admin/api/2025-01/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAdminToken
    },
    body: JSON.stringify({ query })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GraphQL query failed: ${res.status} ${res.statusText} - ${text}`
    );
  }
  const result = (await res.json()) as {
    data: {
      products: {
        edges: Array<{ node: { id: string } }>;
      };
    };
  };
  if (!result.data || !result.data.products || !result.data.products.edges) {
    console.error('GraphQL query result:', result);
    throw new Error("GraphQL query result is missing the 'products' field");
  }
  return result.data.products.edges.length > 0;
}

async function updateArtworkTags(
  productId: string,
  currentTags: string[],
  newTag: string
): Promise<void> {
  if (currentTags.includes(newTag)) return;
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  const updatedTags: string = [...currentTags, newTag].join(', ');
  const url: string = `${shopifyAdminDomain}/products/${productId}.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAdminToken
    },
    body: JSON.stringify({ product: { id: productId, tags: updatedTags } })
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Erreur lors de la mise à jour du produit: ${res.status} ${res.statusText} - ${errorText}`
    );
  }
}

// =============== NOUVEAU : Ajouter des images de variantes pour le sweatshirt ===============

/**
 * Ajoute des images pour chaque couleur de sweatshirt (Blanc, Noir, Bleu Marine).
 * On suppose que vous avez des templates séparés, ex. sweatshirt-blanc.png, sweatshirt-noir.png, sweatshirt-bleumarine.png
 * Si vous n'avez qu'un template unique, vous pouvez adapter.
 */
async function addSweatshirtVariantImages(artworkBuffer: Buffer, product: any) {
  // 1) Mapping couleur -> template
  //    Mettez ces fichiers dans votre "public/templates" si vous les avez.
  const colorTemplates: { [key: string]: string } = {
    Blanc: path.join(
      process.cwd(),
      'public',
      'templates',
      'sweatshirt-blanc.png'
    ),
    Noir: path.join(
      process.cwd(),
      'public',
      'templates',
      'sweatshirt-noir.png'
    ),
    'Bleu Marine': path.join(
      process.cwd(),
      'public',
      'templates',
      'sweatshirt-bleumarine.png'
    )
  };

  // 2) Récupérer la liste des variantes du produit
  //    Shopify renvoie un tableau "variants" : {id, title, option1, ...}
  const variants = product.variants as Array<{
    id: number;
    title: string;
    option1: string;
  }>;

  // 3) Pour chaque couleur définie dans colorTemplates
  for (const color of Object.keys(colorTemplates)) {
    // 3a) Chercher les variantes correspondantes (ex. "Noir - S", "Noir - M")
    const matchingVariants = variants.filter((v) => v.option1.includes(color));
    if (matchingVariants.length === 0) {
      console.log(`Aucune variante trouvée pour la couleur : ${color}`);
      continue;
    }

    // 3b) Générer le mockup pour cette couleur
    const templatePath = colorTemplates[color];
    // On réutilise "positioningConfig.sweatshirt"
    const compositeOptions = positioningConfig['sweatshirt'];
    const colorMockupBuffer = await generateMockup(
      artworkBuffer,
      compositeOptions,
      templatePath
    );

    // 3c) Convertir en base64
    const base64Image = colorMockupBuffer.toString('base64');

    // 3d) Pour chaque variante correspondant à cette couleur, on crée une image associée
    for (const variantObj of matchingVariants) {
      await addImageToShopifyVariant(product.id, variantObj.id, base64Image);
    }
  }
}

/**
 * Ajoute une image à une variante Shopify (POST /products/{productId}/images.json).
 */
async function addImageToShopifyVariant(
  productId: number,
  variantId: number,
  base64Image: string
) {
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;

  // Dans Shopify, pour associer une image à une variante, on utilise la propriété "variant_ids"
  // L'API : POST /products/{productId}/images.json
  const url = `${shopifyAdminDomain}/products/${productId}/images.json`;
  const body = {
    image: {
      attachment: base64Image,
      variant_ids: [variantId]
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAdminToken
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Erreur lors de l'ajout de l'image à la variante ${variantId} : ${res.status} ${res.statusText} - ${errorText}`
    );
  }
  console.log(
    `Image ajoutée à la variante ${variantId} du produit ${productId}`
  );
}

// =============== FIN DU NOUVEAU CODE ===============

async function createDerivedProducts(
  payload: GenerateDerivativesPayload
): Promise<any[]> {
  const { artworkId, artworkTitle, artworkImageUrl } = payload;
  const artworkBuffer: Buffer = await downloadImage(artworkImageUrl);
  const createdProducts: any[] = [];

  for (const def of derivedProductDefinitions) {
    if (await derivativeExists(artworkTitle, def.name)) {
      console.log(`Produit "${artworkTitle} - ${def.name}" existe déjà.`);
      continue;
    }
    // Génération du mockup principal (image de base du produit)
    const compositeBuffer: Buffer = await generateMockup(
      artworkBuffer,
      def.compositeOptions,
      def.template
    );

    // Conversion en base64 pour la première image
    const base64Image: string = compositeBuffer.toString('base64');
    const productTitle: string = `${artworkTitle} - ${def.name}`;
    const productDescription: string = `<p>${def.description}</p><p>Produit dérivé de l’œuvre "${artworkTitle}".</p>`;

    let options: Array<{ name: string }> | undefined;
    let variants: Array<{ option1: string; price: string; sku: string }>;
    if (def.variants) {
      options = [{ name: 'Option' }];
      variants = def.variants.map((v) => ({
        option1: v.option,
        price: v.price,
        sku: `${artworkId}-${
          v.skuSuffix ? v.skuSuffix : v.option.replace(/\s+/g, '').toLowerCase()
        }`
      }));
    } else {
      variants = [
        {
          option1: 'Standard',
          price: def.price || '0.00',
          sku: `${artworkId}-standard`
        }
      ];
    }

    const productData: ShopifyProduct = {
      title: productTitle,
      body_html: productDescription,
      vendor: 'Anne Mondy',
      product_type: def.name,
      images: [{ attachment: base64Image }], // 1ère image
      tags: ['Derivative', artworkId, 'GeneratedByAutomation'],
      options,
      variants,
      published_at: new Date().toISOString(),
      published_scope: 'global',
      status: 'active'
    };

    // Création du produit dérivé sur Shopify
    const createdProduct = await createShopifyProduct(productData);
    createdProducts.push(createdProduct);

    // Ajout aux collections définies (ex: "Boutique")
    if (def.collections && def.collections.length > 0) {
      await addProductToCollectionsByNames(
        createdProduct.product.id,
        def.collections
      );
    }

    // === NOUVEAU : si c'est le sweatshirt, on génère un mockup par couleur et on l'associe aux variantes ===
    if (def.name === 'Le Sweat Shirt à Capuche Unisexe') {
      await addSweatshirtVariantImages(artworkBuffer, createdProduct.product);
    }
    // === Fin du nouveau bloc ===
  }
  return createdProducts;
}

// ---------- Webhook Endpoint & Queue Processing ----------

// Endpoint pour recevoir le webhook et l'ajouter à la file d'attente
app.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawBody: Buffer = (req as any).rawBody;
    const hmacHeader: string | undefined =
      req.get('x-shopify-hmac-sha256') || undefined;
    if (!hmacHeader) {
      res.status(400).json({ error: 'HMAC manquant' });
      return;
    }
    const generatedHmac: string = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('base64');
    if (generatedHmac !== hmacHeader) {
      res.status(401).json({ error: 'Signature invalide' });
      return;
    }

    const payload = req.body;
    if (payload.product_type !== 'Oeuvre') {
      res.json({ message: 'Produit non concerné' });
      return;
    }

    const job: Job = await webhookQueue.add({ payload });
    console.log(`Job ${job.id} ajouté pour le produit ${payload.id}`);
    res.json({ message: "Webhook reçu et mis en file d'attente" });
  } catch (error: any) {
    console.error('Erreur dans le webhook Shopify :', error);
    res.status(500).json({ error: error.message || 'Erreur inconnue' });
  }
});

// Traitement des jobs de la file d'attente
webhookQueue.process(async (job: Job): Promise<void> => {
  const { payload } = job.data as { payload: any };
  const productId: string = payload.id.toString();

  if (locks.has(productId)) {
    console.log(`Produit ${productId} déjà en cours de traitement.`);
    return;
  }
  locks.set(productId, true);

  try {
    const artworkImageUrl: string | null =
      payload.images && payload.images.length > 0
        ? payload.images[0].src
        : null;
    if (!artworkImageUrl) {
      throw new Error('Aucune image trouvée dans le payload');
    }

    if (payload.id && payload.tags) {
      const currentTags: string[] = payload.tags
        .split(',')
        .map((t: string) => t.trim());
      if (
        currentTags.includes('DerivativesProcessing') ||
        currentTags.includes('DerivativesGenerated')
      ) {
        console.log(
          `Produit ${productId} déjà marqué comme traité ou en traitement.`
        );
        return;
      }
      await updateArtworkTags(productId, currentTags, 'DerivativesProcessing');
    }

    const artwork: GenerateDerivativesPayload = {
      artworkId: payload.id.toString(),
      artworkTitle: payload.title,
      artworkDescription: payload.body_html,
      artworkImageUrl,
      createDerivatives: true
    };

    const createdProducts: any[] = await createDerivedProducts(artwork);

    if (payload.id && payload.tags) {
      const currentTags: string[] = payload.tags
        .split(',')
        .map((t: string) => t.trim());
      const newTags: string[] = currentTags.filter(
        (t: string) => t !== 'DerivativesProcessing'
      );
      if (!newTags.includes('DerivativesGenerated')) {
        newTags.push('DerivativesGenerated');
      }
      await updateArtworkTags(productId, currentTags, 'DerivativesGenerated');
    }

    console.log(
      `Produit ${productId} traité avec succès. Produits dérivés créés:`,
      createdProducts
    );
  } catch (error: any) {
    console.error(`Erreur lors du traitement du produit ${productId}:`, error);
    throw error; // Pour permettre à Bull de gérer le retry
  } finally {
    locks.delete(productId);
  }
});

// ---------- Démarrer le serveur Express ----------
app.listen(PORT, () => {
  console.log(`Microservice webhook écoute sur le port ${PORT}`);
});
