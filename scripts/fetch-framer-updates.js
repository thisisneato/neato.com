import { connect } from "framer-api";
import { writeFileSync } from "fs";

const projectUrl = process.env.FRAMER_PROJECT_URL;
const apiKey = process.env.FRAMER_API_KEY;
const collectionId = process.env.FRAMER_BLOG_COLLECTION_ID;

const framer = await connect(projectUrl, apiKey);

try {
  const collection = await framer.getCollection(collectionId);

  if (!collection) {
    throw new Error(
      "Blog collection not found for FRAMER_BLOG_COLLECTION_ID. " +
      "Run the discovery workflow again if you need to re-check the id."
    );
  }

  const items = await collection.getItems();

  const posts = items
    .filter((item) => !item.draft)
    .map((item) => ({
      slug: item.slug,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
    }));

  writeFileSync(
    "blog-updates.json",
    JSON.stringify({ posts, fetchedAt: new Date().toISOString() }, null, 2)
  );

  console.log(`Wrote ${posts.length} posts to blog-updates.json`);
} finally {
  await framer.disconnect();
}
