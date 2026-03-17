'use client';

import React from "react";
import { FaCarSide } from "react-icons/fa";

interface InfoHeroProps {
  title?: string;
  children: React.ReactNode;
}

export default function InfoHero({ title, children }: InfoHeroProps) {
  return (
    <div className="flex flex-col md:flex-row items-start gap-3 p-3 max-w-2xl mx-auto">
      {/* Icona */}
      <div className="text-[#ff3036] text-4xl md:text-5xl flex-shrink-0">
        <FaCarSide />
      </div>

      {/* Testo */}
      <div className="flex flex-col gap-1.5">
        {title && (
          <h1 className="text-[#ff3036] font-extrabold text-3xl md:text-4xl leading-tight">
            {title}
          </h1>
        )}
        <p className="text-[#ff3036] font-medium text-base md:text-lg leading-relaxed">
          {children}
        </p>
      </div>
    </div>
  );
}
