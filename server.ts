import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
  cloud_name: process.env.VITE_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route: Xóa ảnh Cloudinary
  app.post("/api/cloudinary/delete", async (req, res) => {
    try {
      const { publicIds } = req.body;
      if (!publicIds || !Array.isArray(publicIds) || publicIds.length === 0) {
        return res.status(400).json({ success: false, error: "publicIds is required and should be an array" });
      }

      console.log(`[Cloudinary] Yêu cầu xóa các ảnh với public ID:`, publicIds);
      const results = await Promise.all(
        publicIds.map(async (id) => {
          try {
            const res = await cloudinary.uploader.destroy(id);
            return { id, result: res.result };
          } catch (err) {
            console.error(`[Cloudinary] Lỗi khi xóa id ${id}:`, err);
            return { id, error: err instanceof Error ? err.message : String(err) };
          }
        })
      );

      res.json({ success: true, results });
    } catch (error) {
      console.error("[Cloudinary] Lỗi API delete:", error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Liệt kê tất cả ảnh trên Cloudinary (phân trang)
  app.get("/api/cloudinary/list", async (req, res) => {
    try {
      const maxResults = Math.min(parseInt(req.query.max_results as string) || 500, 500);
      const nextCursor = req.query.next_cursor as string | undefined;

      const result = await cloudinary.api.resources({
        type: 'upload',
        max_results: maxResults,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      });

      const resources = (result.resources || []).map((r: any) => ({
        public_id: r.public_id,
        secure_url: r.secure_url,
        format: r.format,
        bytes: r.bytes,
        created_at: r.created_at,
      }));

      res.json({
        success: true,
        resources,
        total_count: result.rate_limit_remaining !== undefined ? undefined : resources.length,
        next_cursor: result.next_cursor || null,
      });
    } catch (error) {
      console.error("[Cloudinary] Lỗi API list:", error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // API Route: Healthcheck
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
