'use client';
import { FaUser, FaPlus, FaMinus } from "react-icons/fa";

interface PostiSelectorProps {
  value: number;
  onChange: (val: number) => void;
}

export default function PostiSelector({ value, onChange }: PostiSelectorProps) {
  const inc = (e: React.MouseEvent) => {
    e.stopPropagation(); // blocca la propagazione al parent
    onChange(value + 1);
  };

  const dec = (e: React.MouseEvent) => {
    e.stopPropagation(); // blocca la propagazione al parent
    if (value > 1) onChange(value - 1);
  };

  return (
    <div
      className="w-full p-4 bg-white rounded-xl flex items-center justify-between gap-4 cursor-pointer"
      onClick={(e) => e.stopPropagation()} // blocca click sul container
    >
      {/* ICONA + NUMERO */}
      <div className="flex items-center gap-2">
        <FaUser className="text-[#ff3036] w-6 h-6" />
        <span className="text-sm font-medium">{value} {value === 1 ? "passeggero" : "passeggeri"}</span>
      </div>

      {/* BOTTONI + / - */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={dec}
          className={`w-8 h-8 rounded-full flex items-center justify-center text-white ${value === 1 ? "bg-gray-300" : "bg-[#ff3036]"}`}
        >
          <FaMinus className="w-3 h-3"/>
        </button>
        <span className="w-6 text-center font-semibold">{value}</span>
        <button
          type="button"
          onClick={inc}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-[#ff3036] text-white"
        >
          <FaPlus className="w-3 h-3"/>
        </button>
      </div>
    </div>
  );
}