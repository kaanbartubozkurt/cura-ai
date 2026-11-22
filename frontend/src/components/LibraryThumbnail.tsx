'use client';

import type { ImgHTMLAttributes } from 'react';
import { useImagePixels } from '@/hooks/useImagePixels';
import type { Image } from '@/types';
import { imagesApi } from '@/lib/api';
import ProgressiveImage from './ProgressiveImage';

/** Thumbnail sizes bound the longest edge, rather than just the width. */
export default function LibraryThumbnail({ image, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { image: Image }) {
  const { host, pixels } = useImagePixels(image.width, image.height);
  const variants = [
    { size: 200, url: image.thumbnail_urls?.['200'], uri: image.thumbnail_uri_small },
    { size: 400, url: image.thumbnail_urls?.['400'], uri: image.thumbnail_uri_medium },
    { size: 800, url: image.thumbnail_urls?.['800'], uri: image.thumbnail_uri_large },
  ].filter(v => v.url || v.uri);
  const chosen = variants.find(v => v.size >= pixels) || variants[variants.length - 1];
  const src = chosen?.url || (chosen?.uri ? imagesApi.getThumbnailUrl(chosen.uri.split('/').pop()!) : image.thumbnail_url);
  const low = variants[0];
  const lowSrc = low?.url || (low?.uri ? imagesApi.getThumbnailUrl(low.uri.split('/').pop()!) : image.thumbnail_url);
  return (
    <span ref={host} className="block h-full w-full">
      {lowSrc && <ProgressiveImage {...props} src={lowSrc} highSrc={pixels > 0 ? src || undefined : undefined} />}
    </span>
  );
}
