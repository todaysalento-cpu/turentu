// ======================= helpers/cloudinary.js =======================
import fetch from 'node-fetch';
import FormData from 'form-data';

/**
 * uploadFile(fileBuffer, filename)
 * @param {Buffer|string} fileBuffer - Contenuto del file da uploadare (Buffer o Base64)
 * @param {string} filename - Nome del file
 * @returns {Promise<string|null>} URL del file su Cloudinary oppure null se fallisce
 */
export async function uploadFile(fileBuffer, filename) {
  try {
    if (!fileBuffer) return null;

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!cloudName) throw new Error('CLOUDINARY_CLOUD_NAME non impostato in .env');
    if (!uploadPreset) throw new Error('CLOUDINARY_UPLOAD_PRESET non impostato in .env');

    const formData = new FormData();
    formData.append('file', fileBuffer, { filename });
    formData.append('upload_preset', uploadPreset);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();

    if (!data.secure_url) {
      console.error('Cloudinary upload fallito:', data);
      return null;
    }

    return data.secure_url;
  } catch (err) {
    console.error('Errore upload Cloudinary:', err);
    return null;
  }
}