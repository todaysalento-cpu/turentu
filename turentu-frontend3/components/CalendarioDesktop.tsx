'use client';

import { useState, useEffect, useRef } from "react";
import { Calendar } from "react-calendar";
import { FaCalendarAlt } from "react-icons/fa";
import 'react-calendar/dist/Calendar.css';
import { motion, AnimatePresence } from "framer-motion";

interface DesktopCalendarProps {
  value: string;
  onChange: (iso: string) => void;
  isActive?: boolean;
  onClick?: () => void;
}

export default function DesktopCalendar({ value, onChange, isActive, onClick }: DesktopCalendarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleToggle = () => {
    setOpen(!open);
    onClick?.();
  };

  const selectedDate = value ? new Date(value) : null;

  // Funzione per stabilire se un giorno è festivo
  const isHoliday = (date: Date) => {
    const day = date.getDay();
    const month = date.getMonth() + 1; // Gennaio = 0
    const dayOfMonth = date.getDate();

    // Sabato o domenica
    if (day === 0 || day === 6) return true;

    // Alcuni festivi fissi italiani
    const fixedHolidays = [
      "1-1",   // Capodanno
      "6-1",   // Epifania
      "25-4",  // Liberazione
      "1-5",   // Festa del lavoro
      "2-6",   // Repubblica
      "15-8",  // Ferragosto
      "1-11",  // Ognissanti
      "8-12",  // Immacolata
      "25-12", // Natale
      "26-12", // Santo Stefano
    ];
    return fixedHolidays.includes(`${dayOfMonth}-${month}`);
  };

  return (
    <motion.div className="relative w-[150px]">
      {/* Input box */}
      <motion.div
        onClick={handleToggle}
        className={`
          flex flex-col justify-center items-start px-4 py-2 cursor-pointer rounded-md
          border-2 ${isActive ? "border-[#ff3036] shadow-md" : "border-black/80"}
          bg-white transition-all duration-200
        `}
      >
        <div className="flex items-center gap-1 mb-0.5">
          <FaCalendarAlt className="text-[#ff3036] text-base" />
          <span className="text-[8px] uppercase tracking-wider text-slate-500">Data</span>
        </div>
        <span className="text-sm font-medium text-slate-800 truncate">
          {value
            ? new Date(value).toLocaleString("it-IT", {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "Seleziona"}
        </span>
      </motion.div>

      {/* Dropdown calendario */}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={ref}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-[320px] bg-white rounded-md shadow-md z-50 p-2 border border-black/80"
          >
            <Calendar
              value={selectedDate ?? new Date()}
              onChange={(date: Date) => {
                onChange(date.toISOString().slice(0, 16));
                setOpen(false);
              }}
              tileClassName={({ date, view }) => {
                if (view === "month") {
                  let classes = "";

                  if (selectedDate &&
                    date.getDate() === selectedDate.getDate() &&
                    date.getMonth() === selectedDate.getMonth() &&
                    date.getFullYear() === selectedDate.getFullYear()) {
                    classes += " selected-tile";
                  }

                  if (isHoliday(date)) {
                    classes += " holiday-tile";
                  }

                  return classes;
                }
                return "";
              }}
              className="bg-white text-black [&_.react-calendar__tile]:rounded-none [&_.react-calendar__tile--now]:bg-white [&_.react-calendar__tile--now]:text-black"
            />
            <style jsx global>{`
              .react-calendar {
                background: white !important;
                color: black !important;
                border: none !important;
              }
              .react-calendar__tile {
                border-radius: 0 !important;
                color: black !important;
              }
              .react-calendar__tile:hover {
                background: #e2e2e2 !important;
              }
              .react-calendar__tile--now {
                background: white !important;
                color: black !important;
              }
              .react-calendar__tile--active,
              .selected-tile {
                background: black !important;
                color: white !important;
                border-radius: 0 !important;
              }
              .holiday-tile {
                font-weight: bold !important;
              }
            `}</style>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}