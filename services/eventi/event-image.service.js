import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { cloudinary } from '../cloudinary.js';

const MAX_INPUT = 10 * 1024 * 1024;
const MAX_OUTPUT = 150 * 1024;
const FORMATS = new Set(['jpeg', 'png', 'webp']);

export async function optimizeEventImage(input) {
  if (!Buffer.isBuffer(input)) {
    throw new Error('Immagine non valida');
  }

  if (!input.length || input.length > MAX_INPUT) {
    throw new Error('Dimensione immagine non consentita');
  }

  const options = {
    limitInputPixels: 25000000,
    failOn: 'error'
  };

  const metadata = await sharp(input, options).metadata();

  if (!FORMATS.has(metadata.format)) {
    throw new Error('Formato immagine non supportato');
  }

  if ((metadata.pages || 1) > 1) {
    throw new Error('Immagini animate non supportate');
  }

  for (const quality of [80, 75, 70, 60, 50, 40]) {
    const buffer = await sharp(input, options)
      .rotate()
      .resize(480, 640, {
        fit: 'contain',
        background: '#ffffff'
      })
      .webp({ quality, effort: 4 })
      .toBuffer();

    if (buffer.length <= MAX_OUTPUT) {
      return {
        buffer,
        hash: createHash('sha256')
          .update(buffer)
          .digest('hex'),
        bytes: buffer.length,
        width: 480,
        height: 640,
        format: 'webp'
      };
    }
  }

  throw new Error('Impossibile ottimizzare la copertina');
}

export async function uploadEventImage(input) {
  const image = await optimizeEventImage(input);

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'turentu_eventi/copertine',
        public_id: image.hash,
        resource_type: 'image',
        format: 'webp',
        overwrite: false,
        unique_filename: false
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.on('error', reject);
    stream.end(image.buffer);
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    hash: image.hash,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    format: image.format
  };
}

export async function uploadEventImageBase64(value) {
  if (typeof value !== 'string') {
    throw new Error('Immagine Base64 non valida');
  }

  if (value.length > Math.ceil(MAX_INPUT / 3) * 4 + 100) {
    throw new Error('Immagine troppo grande');
  }

  const match = value.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/
  );

  if (!match) {
    throw new Error('Formato Base64 non supportato');
  }

  return uploadEventImage(
    Buffer.from(match[2], 'base64')
  );
}