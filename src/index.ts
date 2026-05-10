import express from "express";
import cors from "cors";
import { router } from "./api/routes.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", router);
const port = Number(process.env.PORT) || 3001;
app.listen(port, () =>
  console.log(`Bronson orchestrator running on http://localhost:${port}`)
);
