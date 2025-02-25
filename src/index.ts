// server.ts
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import Bull, { Job } from "bull";

// ---------- Middleware pour conserver le body brut ----------
const rawBodySaver = (req: Request, res: Response, buf: Buffer, encoding: string) => {
  (req as any).rawBody = buf;
};

const app = express();
app.use(bodyParser.json({ verify: rawBodySaver }));

// ---------- Variables d'environnement ----------
const SHOPIFY_WEBHOOK_SECRET: string = process.env.SHOPIFY_WEBHOOK_SECRET!;
if (!SHOPIFY_WEBHOOK_SECRET) {
  throw new Error("SHOPIFY_WEBHOOK_SECRET is not defined");
}

const PORT: number = parseInt(process.env.PORT || "3000", 10);

const redisHost: string = process.env.REDIS_HOST || "127.0.0.1";
const redisPort: number = parseInt(process.env.REDIS_PORT || "6379", 10);
const redisPassword: string | undefined = process.env.REDIS_PASSWORD;

// ---------- Configuration de la file d'attente Bull ----------
const webhookQueue = new Bull("shopify-webhook", {
  redis: {
    host: redisHost,
    port: redisPort,
    password: redisPassword,
  },
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
  "grand-sac-de-plage": { top: 524, left: 327, width: 264, height: 265 },
  "coque-de-telephone": { top: 50, left: 30, width: 200, height: 200 },
  "tote-bag": { top: 522, left: 321, width: 309, height: 310 },
  "tee-shirt-homme": { top: 164, left: 291, width: 329, height: 330 },
  "tee-shirt-femme": { top: 321, left: 312, width: 340, height: 341 },
  sweatshirt: { top: 216, left: 318, width: 336, height: 337 },
  plexiglas: { top: 274, left: 140, width: 317, height: 215 },
};

const derivedProductDefinitions: DerivedProductDefinition[] = [
    {
        name: "Les Oeuvres sur Plexiglas",
        description: `• Trois formats disponibles<br>
    • Acrylique brillant transparent de 3 mm<br>
    • Trous pré-percés, entretoises et languettes adhésives disponibles<br>
    • Impression en couleur de qualité<br><br>
    Remarque : Chaque impression est protégée par un film vert détachable. Retirez-le avant l’affichage.<br>
    À la recherche d’une décoration murale originale ? Le plexiglas met en valeur les couleurs pour un rendu réaliste et vibrant.`,
        template: path.join(process.cwd(), "public", "templates", "plexiglas.png"),
        compositeOptions: positioningConfig["plexiglas"] || {
          top: 0,
          left: 0,
          width: 500,
          height: 500,
        },
        variants: [
          { option: "40X30", price: "100.00", skuSuffix: "40x30" },
          { option: "60X40", price: "180.00", skuSuffix: "60x40" },
          { option: "90X60", price: "250.00", skuSuffix: "90x60" },
        ],
        price: "100.00",
        collections: ["Boutique"],
      },
      {
        name: "Le Sac fourre-tout Deluxe en coton",
        description: `Toile 100 % coton, 320 g/m²<br>
    Dimensions : 38 cm H x 47 cm L x 12 cm P<br>
    Longueur des anses : 26 cm`,
        template: path.join(process.cwd(), "public", "templates", "tote-bag.png"),
        compositeOptions: positioningConfig["tote-bag"] || {
          top: 0,
          left: 0,
          width: 500,
          height: 500,
        },
        price: "30.00",
        collections: ["Boutique"],
      },
      {
        name: "Le Tee Shirt HOMME",
        description: `Manches courtes / Blanc<br>
    Tailles : S, M, L, XL<br>
    100 % coton léger (Blanc), 99 % coton, 1 % polyester (gris cendré), 97 % coton, 3 % polyester (gris chiné)<br>
    Coutures doubles pour une résistance accrue`,
        template: path.join(
          process.cwd(),
          "public",
          "templates",
          "tee-shirt-homme.png",
        ),
        compositeOptions: positioningConfig["tee-shirt-homme"] || {
          top: 0,
          left: 0,
          width: 500,
          height: 500,
        },
        variants: [
          { option: "S", price: "40.00" },
          { option: "M", price: "40.00" },
          { option: "L", price: "40.00" },
          { option: "XL", price: "40.00" },
        ],
        price: "40.00",
        collections: ["Boutique"],
      },
      {
        name: "Le Tee Shirt Femme",
        description: `Manches courtes / Blanc<br>
        Tailles : S, M, L, XL<br>
        100 % coton léger (Blanc), 99 % coton, 1 % polyester (gris cendré), 97 % coton, 3 % polyester (gris chiné)<br>
        Coutures doubles pour une résistance accrue`,
        template: path.join(
          process.cwd(),
          "public",
          "templates",
          "tee-shirt-femme.png",
        ),
        compositeOptions: positioningConfig["tee-shirt-femme"] || {
          top: 0,
          left: 0,
          width: 500,
          height: 500,
        },
        variants: [
          { option: "XS", price: "40.00" },
          { option: "S", price: "40.00" },
          { option: "M", price: "40.00" },
          { option: "L", price: "40.00" },
        ],
        price: "40.00",
        collections: ["Boutique"],
      },
      {
        name: "Le Grand Sac de Plage",
        description: `Disponible en Noir ou Blanc`,
        template: path.join(
          process.cwd(),
          "public",
          "templates",
          "grand-sac-de-plage.png",
        ),
        compositeOptions: positioningConfig["grand-sac-de-plage"] || {
          top: 0,
          left: 0,
          width: 500,
          height: 500,
        },
        variants: [
          { option: "Noir", price: "45.00" },
          { option: "Blanc", price: "45.00" },
        ],
        price: "45.00",
        collections: ["Boutique"],
      },
      {
        name: "Le Sweat Shirt à Capuche Unisexe",
        description: `Mélange léger 80 % coton et 20 % polyester, 280 g/m²<br>
    Coupe Regular<br>
    Capuche avec cordon de serrage<br>
    Poche avant kangourou<br>
    Disponible en Blanc, Noir et Bleu Marine<br>
    Tailles : S, M, L, XL`,
        template: path.join(process.cwd(), "public", "templates", "sweatshirt.png"),
        compositeOptions: positioningConfig["sweatshirt"] || {
          top: 0,
          left: 0,
          width: 500,
          height: 500,
        },
        collections: ["Boutique"],
        variants: (() => {
          const colors = ["Blanc", "Noir", "Bleu Marine"];
          const sizes = ["S", "M", "L", "XL"];
          const vars: Array<{ option: string; price: string; skuSuffix?: string }> =
            [];
          for (const color of colors) {
            for (const size of sizes) {
              vars.push({
                option: `${color} - ${size}`,
                price: "75.00",
                skuSuffix: `${color}-${size}`.replace(/\s+/g, "").toLowerCase(),
              });
            }
          }
          return vars;
        })(),
      },
      {
        name: "Coque de téléphone",
        description: `Coque dérivée de l’œuvre. Prix fixe.<br>
    Pour personnaliser, veuillez renseigner votre modèle lors de la commande.`,
        template: path.join(
          process.cwd(),
          "public",
          "templates",
          "phone",
          "generic-phone.png",
        ),
        compositeOptions: positioningConfig["coque-de-telephone"] || {
          top: 0,
          left: 0,
          width: 500,
          height: 500,
        },
        price: "29.99",
        collections: ["Boutique"],
      },
];

// ---------- Fonctions Utilitaires ----------
async function getCollectionIdByName(collectionName: string): Promise<string | null> {
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  
  // Custom collections
  const url: string = `${shopifyAdminDomain}/custom_collections.json?title=${encodeURIComponent(collectionName)}`;
  let res = await fetch(url, { headers: { "X-Shopify-Access-Token": shopifyAdminToken } });
  if (res.ok) {
    const data = (await res.json()) as CustomCollectionsResponse;
    if (data.custom_collections && data.custom_collections.length > 0) {
      return data.custom_collections[0].id.toString();
    }
  } else {
    console.error(`Erreur lors de la récupération de la collection "${collectionName}" : ${res.statusText}`);
  }
  
  // Smart collections
  const smartUrl: string = `${shopifyAdminDomain}/smart_collections.json?title=${encodeURIComponent(collectionName)}`;
  res = await fetch(smartUrl, { headers: { "X-Shopify-Access-Token": shopifyAdminToken } });
  if (res.ok) {
    const smartData = (await res.json()) as SmartCollectionsResponse;
    if (smartData.smart_collections && smartData.smart_collections.length > 0) {
      return smartData.smart_collections[0].id.toString();
    }
  } else {
    console.error(`Erreur lors de la récupération de la smart collection "${collectionName}" : ${res.statusText}`);
  }
  
  return null;
}

async function addProductToCollectionsByNames(productId: string, collectionNames: string[]): Promise<void> {
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  for (const collectionName of collectionNames) {
    const collectionId = await getCollectionIdByName(collectionName);
    if (collectionId) {
      const url: string = `${shopifyAdminDomain}/collects.json`;
      const body = { collect: { product_id: productId, collection_id: collectionId } };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": shopifyAdminToken,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`Erreur lors de l'association du produit ${productId} à la collection "${collectionName}": ${await res.text()}`);
      }
    } else {
      console.error(`Collection "${collectionName}" introuvable.`);
    }
  }
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Erreur lors du téléchargement de l’image: ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function generateMockup(
  artworkBuffer: Buffer,
  compositeOptions: CompositeOptions,
  templatePath: string,
): Promise<Buffer> {
  const templateBuffer = await fs.readFile(templatePath);
  const templateMeta = await sharp(templateBuffer).metadata();
  if (!templateMeta.width || !templateMeta.height) {
    throw new Error("Impossible de récupérer les dimensions du template.");
  }
  const maxAllowedWidth: number = templateMeta.width - compositeOptions.left;
  const maxAllowedHeight: number = templateMeta.height - compositeOptions.top;
  const targetWidth: number = Math.min(compositeOptions.width, maxAllowedWidth);
  const targetHeight: number = Math.min(compositeOptions.height, maxAllowedHeight);
  
  let overlay: Buffer = await sharp(artworkBuffer)
    .resize(targetWidth, targetHeight, { fit: "inside" })
    .toBuffer();
  const overlayMeta = await sharp(overlay).metadata();
  if ((overlayMeta.width || 0) < targetWidth || (overlayMeta.height || 0) < targetHeight) {
    overlay = await sharp(overlay)
      .extend({
        top: 0,
        bottom: targetHeight - (overlayMeta.height || targetHeight),
        left: 0,
        right: targetWidth - (overlayMeta.width || targetWidth),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();
  }
  const compositeBuffer: Buffer = await sharp(templateBuffer)
    .composite([{ input: overlay, top: compositeOptions.top, left: compositeOptions.left, blend: "overlay" }])
    .png()
    .toBuffer();
  return compositeBuffer;
}

async function createShopifyProduct(productData: ShopifyProduct): Promise<any> {
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  const idempotencyKey: string = crypto.createHash("sha256").update(productData.title).digest("hex");
  const url: string = `${shopifyAdminDomain}/products.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shopifyAdminToken,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ product: productData }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Erreur Shopify API: ${res.status} ${res.statusText} - ${errorText}`);
  }
  return res.json();
}

async function derivativeExists(artworkTitle: string, derivativeName: string): Promise<boolean> {
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
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shopifyAdminToken,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL query failed: ${res.status} ${res.statusText} - ${text}`);
  }
  const result = (await res.json()) as {
    data: {
      products: {
        edges: Array<{ node: { id: string } }>;
      };
    };
  };
  if (!result.data || !result.data.products || !result.data.products.edges) {
    console.error("GraphQL query result:", result);
    throw new Error("GraphQL query result is missing the 'products' field");
  }
  return result.data.products.edges.length > 0;
}

async function updateArtworkTags(productId: string, currentTags: string[], newTag: string): Promise<void> {
  if (currentTags.includes(newTag)) return;
  const shopifyAdminDomain: string = process.env.SHOPIFY_ADMIN_DOMAIN!;
  const shopifyAdminToken: string = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
  const updatedTags: string = [...currentTags, newTag].join(", ");
  const url: string = `${shopifyAdminDomain}/products/${productId}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shopifyAdminToken,
    },
    body: JSON.stringify({ product: { id: productId, tags: updatedTags } }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Erreur lors de la mise à jour du produit: ${res.status} ${res.statusText} - ${errorText}`);
  }
}

async function createDerivedProducts(payload: GenerateDerivativesPayload): Promise<any[]> {
  const { artworkId, artworkTitle, artworkImageUrl } = payload;
  const artworkBuffer: Buffer = await downloadImage(artworkImageUrl);
  const createdProducts: any[] = [];
  
  for (const def of derivedProductDefinitions) {
    if (await derivativeExists(artworkTitle, def.name)) {
      console.log(`Produit "${artworkTitle} - ${def.name}" existe déjà.`);
      continue;
    }
    const compositeBuffer: Buffer = await generateMockup(artworkBuffer, def.compositeOptions, def.template);
    const base64Image: string = compositeBuffer.toString("base64");
    const productTitle: string = `${artworkTitle} - ${def.name}`;
    const productDescription: string = `<p>${def.description}</p><p>Produit dérivé de l’œuvre "${artworkTitle}".</p>`;
    
    let options: Array<{ name: string }> | undefined;
    let variants: Array<{ option1: string; price: string; sku: string }>;
    if (def.variants) {
      options = [{ name: "Option" }];
      variants = def.variants.map((v) => ({
        option1: v.option,
        price: v.price,
        sku: `${artworkId}-${v.skuSuffix ? v.skuSuffix : v.option.replace(/\s+/g, "").toLowerCase()}`,
      }));
    } else {
      variants = [{
        option1: "Standard",
        price: def.price || "0.00",
        sku: `${artworkId}-standard`,
      }];
    }
    
    const productData: ShopifyProduct = {
      title: productTitle,
      body_html: productDescription,
      vendor: "Anne Mondy",
      product_type: def.name,
      images: [{ attachment: base64Image }],
      tags: ["Derivative", artworkId, "GeneratedByAutomation"],
      options,
      variants,
      published_at: new Date().toISOString(),
      published_scope: "global",
    };
    
    const createdProduct = await createShopifyProduct(productData);
    createdProducts.push(createdProduct);
    
    if (def.collections && def.collections.length > 0) {
      await addProductToCollectionsByNames(createdProduct.product.id, def.collections);
    }
  }
  return createdProducts;
}

// ---------- Webhook Endpoint & Queue Processing ----------

// Endpoint pour recevoir le webhook et l'ajouter à la file d'attente
app.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  try {
    const rawBody: Buffer = (req as any).rawBody;
    const hmacHeader: string | undefined = req.get("x-shopify-hmac-sha256") || undefined;
    if (!hmacHeader) {
      res.status(400).json({ error: "HMAC manquant" });
      return;
    }
    const generatedHmac: string = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("base64");
    if (generatedHmac !== hmacHeader) {
      res.status(401).json({ error: "Signature invalide" });
      return;
    }
    
    const payload = req.body;
    if (payload.product_type !== "Oeuvre") {
      res.json({ message: "Produit non concerné" });
      return;
    }
    
    const job: Job = await webhookQueue.add({ payload });
    console.log(`Job ${job.id} ajouté pour le produit ${payload.id}`);
    res.json({ message: "Webhook reçu et mis en file d'attente" });
  } catch (error: any) {
    console.error("Erreur dans le webhook Shopify :", error);
    res.status(500).json({ error: error.message || "Erreur inconnue" });
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
    const artworkImageUrl: string | null = (payload.images && payload.images.length > 0)
      ? payload.images[0].src
      : null;
    if (!artworkImageUrl) {
      throw new Error("Aucune image trouvée dans le payload");
    }
    
    if (payload.id && payload.tags) {
      const currentTags: string[] = payload.tags.split(",").map((t: string) => t.trim());
      if (currentTags.includes("DerivativesProcessing") || currentTags.includes("DerivativesGenerated")) {
        console.log(`Produit ${productId} déjà marqué comme traité ou en traitement.`);
        return;
      }
      await updateArtworkTags(productId, currentTags, "DerivativesProcessing");
    }
    
    const artwork: GenerateDerivativesPayload = {
      artworkId: payload.id.toString(),
      artworkTitle: payload.title,
      artworkDescription: payload.body_html,
      artworkImageUrl,
      createDerivatives: true,
    };
    
    const createdProducts: any[] = await createDerivedProducts(artwork);
    
    if (payload.id && payload.tags) {
      const currentTags: string[] = payload.tags.split(",").map((t: string) => t.trim());
      const newTags: string[] = currentTags.filter((t: string) => t !== "DerivativesProcessing");
      if (!newTags.includes("DerivativesGenerated")) {
        newTags.push("DerivativesGenerated");
      }
      await updateArtworkTags(productId, currentTags, "DerivativesGenerated");
    }
    
    console.log(`Produit ${productId} traité avec succès. Produits dérivés créés:`, createdProducts);
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
