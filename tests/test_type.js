'use client';
import React, { useState } from 'react';

export default function Test() {
  const [text, setText] = useState<string>('');
  return <input value={text} onChange={e => setText(e.target.value)} />;
}