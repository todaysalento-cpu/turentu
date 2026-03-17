'use client';

import { useState, useEffect, useRef } from "react";
import { FaMapMarkerAlt } from "react-icons/fa";
import AppInput from "./ui/appInput";

interface LocationValue {
  nome: string;
  indirizzo?: string;
}

interface LocationInputProps {
  label: string;
  value: string;
  suggestions?: LocationValue[];
  onChange?: (val: string) => void;
  onSelect?: (loc: LocationValue) => void;
  readOnly?: boolean;
  isDestinazione?: boolean;
}

export default function LocationInput({
  label,
  value,
  suggestions = [],
  onChange,
  onSelect,
  readOnly = false,
  isDestinazione = false,
}: LocationInputProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Chiudi dropdown se clic fuori
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Filtra suggerimenti in base al valore digitato, ma se vuoto mostra tutti
  const filteredSuggestions = (value ? suggestions.filter(loc =>
    loc.nome.toLowerCase().includes(value.toLowerCase())
  ) : suggestions);

  return (
    <div className="relative w-full" ref={wrapperRef}>
      <AppInput
        value={value ?? ""}
        placeholder={label}
        readOnly={readOnly}
        onClick={() => setShowDropdown(true)} // mostra dropdown al clic
        onChange={(e) => {
          onChange?.(e.target.value);
          setShowDropdown(true); // mostra sempre al digitare
        }}
        icon={<FaMapMarkerAlt className="text-[#ff3036]" />}
      />

      {showDropdown && filteredSuggestions.length > 0 && (
        <ul className="absolute left-0 right-0 bg-white shadow-lg rounded-md mt-1 max-h-60 overflow-y-auto z-50 border border-slate-200">
          {filteredSuggestions.map((loc, idx) => (
            <li
              key={idx}
              className="cursor-pointer px-4 py-2 hover:bg-[#ffe6e9] truncate"
              onClick={() => {
                onSelect?.(loc);
                setShowDropdown(false);
              }}
            >
              <span className="font-medium">{loc.nome}</span>
              {loc.indirizzo && (
                <span className="text-xs text-slate-500 ml-1 truncate">{loc.indirizzo}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}