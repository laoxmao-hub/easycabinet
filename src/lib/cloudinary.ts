/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

async function compressImageToBlob(file: File, maxW = 1920, maxH = 1080, quality = 0.85): Promise<Blob> {
  return new Promise((resolve) => {
    const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(file.name);
    if (!isImage) {
      resolve(file);
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        
        // Dynamic orientation-aware limits for Full HD
        let targetMaxW = maxW;
        let targetMaxH = maxH;
        
        // If portrait/vertical orientation: swap dimensions to allow full 1080x1920 vertical format
        if (height > width) {
          targetMaxW = maxH;
          targetMaxH = maxW;
        }
        
        // Calculate new dimensions keeping the aspect ratio
        if (width > targetMaxW || height > targetMaxH) {
          const ratio = Math.min(targetMaxW / width, targetMaxH / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file);
          return;
        }
        
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              resolve(file);
            }
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => {
        resolve(file);
      };
      img.src = event.target?.result as string;
    };
    reader.onerror = () => {
      resolve(file);
    };
    reader.readAsDataURL(file);
  });
}

async function compressImageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        
        // Resize to max 450px
        const MAX_SIZE = 450;
        if (width > height) {
          if (width > MAX_SIZE) {
            height = Math.round((height * MAX_SIZE) / width);
            width = MAX_SIZE;
          }
        } else {
          if (height > MAX_SIZE) {
            width = Math.round((width * MAX_SIZE) / height);
            height = MAX_SIZE;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(event.target?.result as string);
          return;
        }
        
        ctx.drawImage(img, 0, 0, width, height);
        // Compress as jpeg with low-medium quality
        const dataUrl = canvas.toDataURL('image/jpeg', 0.45);
        resolve(dataUrl);
      };
      img.onerror = () => {
        resolve(event.target?.result as string);
      };
      img.src = event.target?.result as string;
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

export async function uploadToCloudinary(file: File, folder?: string, publicId?: string): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Lỗi hệ thống: Hoàn toàn không được lưu ảnh dưới dạng Base64 vào Firestore để tránh vượt quá giới hạn payload 11MB. Vui lòng cấu hình đầy đủ VITE_CLOUDINARY_CLOUD_NAME và VITE_CLOUDINARY_UPLOAD_PRESET trên môi trường điều hành.");
  }

  // Nén ảnh xuống full HD (1920x1080) trước khi tải lên Cloudinary
  let fileToUpload: File | Blob = file;
  try {
    fileToUpload = await compressImageToBlob(file, 1920, 1080, 0.85);
  } catch (compressErr) {
    console.warn("Lỗi nén ảnh, chuyển sang upload file gốc:", compressErr);
  }

  const formData = new FormData();
  formData.append('file', fileToUpload, file.name);
  formData.append('upload_preset', uploadPreset);
  if (folder) formData.append('folder', folder);
  if (publicId) formData.append('public_id', publicId);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: 'POST',
      body: formData,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const detailMsg = errorData?.error?.message || response.statusText;
    throw new Error(`Tải ảnh lên Cloudinary thất bại: ${detailMsg}`);
  }

  const data = await response.json();
  if (!data?.secure_url) {
    throw new Error('Tải ảnh thành công nhưng Cloudinary không phản hồi đường dẫn secure_url.');
  }
  return data.secure_url;
}

export async function deleteFromCloudinary(secureUrl: string): Promise<boolean> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) return false;

  // Parse public_id from secure_url
  // Example: https://res.cloudinary.com/cloud/image/upload/v1234567890/DG/folder_item_abc.jpg
  try {
    const url = new URL(secureUrl);
    const parts = url.pathname.split('/');

    // Find 'v' + digits pattern to locate version segment
    let vIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (/^v\d+$/.test(parts[i])) {
        vIdx = i;
        break;
      }
    }
    if (vIdx === -1 || vIdx + 1 >= parts.length) return false;

    // Join everything after version as public_id (with folder prefix if any)
    const publicIdWithPath = parts.slice(vIdx + 1).join('/');
    const publicIdWithoutExt = publicIdWithPath.replace(/\.[a-zA-Z0-9]+$/, '');

    // Try unsigned delete using upload_preset
    const formData = new FormData();
    formData.append('public_id', publicIdWithoutExt);
    formData.append('upload_preset', uploadPreset);

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
      { method: 'POST', body: formData }
    );

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      return data.result === 'ok' || data.result === 'not found';
    }
    return false;
  } catch {
    return false;
  }
}
