import { useEffect, useRef } from 'react';
import type { Picture, PictureBitmap } from '@vibefield/puppeteer-view-sdk';
import { isPictureDataUrl } from '@vibefield/puppeteer-view-sdk/toolkit';

export interface HostPictureProps {
  picture: Picture;
  /** Its side, in CSS pixels. */
  size: number;
  className?: string | undefined;
}

/**
 * A host's picture on a row (`HostMark`), drawn at a side: a stencil tinted in the row's ink (`currentColor`), a
 * colour picture as the host drew it. Decorative: the row's own name says who it is. `data-picture` carries the
 * picture's key, so a picture redraws only for a new key. A string that is not a `data:image/…` URL draws nothing, so
 * a mark never makes the view fetch (`isPictureDataUrl`).
 */
export function HostPicture({ picture, size, className }: HostPictureProps) {
  const classes = className ? `vf-host-picture ${className}` : 'vf-host-picture';
  if (picture.kind === 'stencil') {
    return (
      <svg
        className={classes}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        data-picture={picture.key}
      >
        <path d={picture.path} fill="currentColor" />
      </svg>
    );
  }
  if (typeof picture.image === 'string') {
    if (!isPictureDataUrl(picture.image)) return null;
    return (
      <img
        className={classes}
        src={picture.image}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-picture={picture.key}
      />
    );
  }
  return <BitmapPicture className={classes} bitmap={picture.image} size={size} pictureKey={picture.key} />;
}

function BitmapPicture(props: { bitmap: PictureBitmap; size: number; className: string; pictureKey: string }) {
  const { bitmap, size, className, pictureKey } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const scale = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, size * scale, size * scale);
    // A bitmap the model names by its size alone is the browser's ImageBitmap (`PictureBitmap`).
    context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, size * scale, size * scale);
  }, [bitmap, size, scale]);
  return (
    <canvas
      ref={canvas}
      className={className}
      width={size * scale}
      height={size * scale}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-picture={pictureKey}
    />
  );
}
