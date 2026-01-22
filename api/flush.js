import { Redis } from "@upstash/redis";

// Initialize Redis using your existing environment variables
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    // This command deletes ALL keys in the database
    await redis.flushdb();
    
    // Send success message
    res.status(200).send("✅ SUCCESS: Database has been flushed. You can now use the chat!");
  } catch (e) {
    // Send error if something goes wrong
    res.status(500).send("❌ ERROR: " + e.message);
  }
}
