import { lookup } from 'mime-types';

export function getMimeType(fileExtension) {
  // Get the MIME type based on the file extension
  const mimeType = lookup(fileExtension);

  return mimeType;
}
