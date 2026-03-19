import React from "react";

interface AppCardProps {
  children: React.ReactNode;
  className?: string;
}

export default function AppCard({ children, className = "" }: AppCardProps) {
  return (
    <div
      className={`
        bg-white
        rounded-2xl
        shadow-sm
        border border-gray-100
        p-4
        transition
        active:scale-[0.99]
        ${className}
      `}
    >
      {children}
    </div>
  );
}
