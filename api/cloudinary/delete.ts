import type { VercelRequest, VercelResponse } from '@vercel/node';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.VITE_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { publicIds } = req.body;
    if (!publicIds || !Array.isArray(publicIds) || publicIds.length === 0) {
      return res.status(400).json({ success: false, error: 'publicIds is required and should be an array' });
    }

    const results = await Promise.all(
      publicIds.map(async (id: string) => {
        try {
          const result = await cloudinary.uploader.destroy(id);
          return { id, result: result.result };
        } catch (err: any) {
          return { id, error: err.message || String(err) };
        }
      })
    );

    res.json({ success: true, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
}
