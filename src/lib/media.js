const MB = 1024 * 1024;

/** Types de medias acceptes et taille maximale (octets). */
export const MEDIA_TYPES = Object.freeze({
  'image/jpeg': { maxBytes: 10 * MB },
  'image/png': { maxBytes: 10 * MB },
  'image/webp': { maxBytes: 10 * MB },
  'image/gif': { maxBytes: 10 * MB },
  'video/mp4': { maxBytes: 100 * MB },
  'video/webm': { maxBytes: 100 * MB },
});

export const sanitizeFilename = (filename) => {
  const cleaned = filename
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100);
  return cleaned || 'file';
};

export const mediaKey = ({ ownerId, mediaId, filename }) =>
  `media/${ownerId}/${mediaId}/${sanitizeFilename(filename)}`;
