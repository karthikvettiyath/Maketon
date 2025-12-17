import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prefer root .env, then allow server/.env to override.
// This keeps `npm --prefix server run dev` working while allowing a single root env file.
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
dotenv.config({ path: path.resolve(__dirname, ".env") });
