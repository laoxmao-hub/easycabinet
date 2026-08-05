import type { VercelRequest, VercelResponse } from '@vercel/node';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.VITE_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
      next_cursor: result.next_cursor || null,
    });
  } catch (error: any) {
    console.error("[Cloudinary] list error:", error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
}
