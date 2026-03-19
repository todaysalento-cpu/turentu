'use client';
import { ReactNode } from "react";

export default function InputConIcona({
  icon,
  value,
  placeholder,
  onChange,
  readOnly = false,
  className = "",
  onClick,
}: {
  icon: ReactNode;
  value: string;
  placeholder: string;
  onChange?: (e: any) => void;
  readOnly?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div className="relative flex-1 min-w-0 h-13">
      <div className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]">{icon}</div>
      <input
        className={`w-full h-10 pl-8 rounded border border-gray-300 focus:border-[#ff3036] ${className}`}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        readOnly={readOnly}
        onClick={onClick}
      />
    </div>
  );
}
