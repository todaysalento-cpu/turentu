'use client';
import { useEffect } from 'react';

interface Props {
  play: boolean;
}

export default function NotificationSound({ play }: Props) {
  useEffect(() => {
    if (!play) return;
    const audio = new Audio('/sounds/notify.mp3'); // metti un file mp3 in public/sounds/
    audio.play();
  }, [play]);

  return null;
}
