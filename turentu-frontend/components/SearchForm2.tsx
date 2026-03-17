'use client';

import { useState, useEffect } from "react";
import { FaUser, FaMapMarkerAlt, FaCalendarAlt } from "react-icons/fa";
import { motion, AnimatePresence } from "framer-motion";
import PostiSelector from "./PostiSelector";
import MobileSearchCta from "./MobileSearchCTA";
import LocationSheet from "./LocationSheet";
import AppInput from "./ui/appInput";
import InfoBox from "./BoxInformativo";
import DesktopCalendar from "./CalendarioDesktop";
import BottomSheetCalendario from "./BottomSheetCalendario";
import { RicercaForm, LocationValue } from "../types";

interface SearchFormProps {
  form?: RicercaForm;
  dispatch: React.Dispatch<any>;
  onSubmit: () => void;
  loading: boolean;
  isMobile: boolean;
  showResults?: boolean;
}

type ActiveInput = "origine" | "destinazione" | "data" | "posti" | null;

// 🔹 Funzione helper per ottenere ISO locale coerente
const nowLocalISO = () => {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString();
};

// 🔹 Formatta ISO in locale per visualizzazione utente
export const formatLocaleDate = (iso: string) => {
  if (!iso) return "N/D";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "N/D";
  return `${d.toLocaleDateString("it-IT", {
    weekday: "short",
    day: "numeric",
    month: "short",
  })} - ${d.toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

export default function SearchForm({
  form,
  dispatch,
  onSubmit,
  loading,
  isMobile,
  showResults = false,
}: SearchFormProps) {
  const [activeInput, setActiveInput] = useState<ActiveInput>(null);
  const [locationQuery, setLocationQuery] = useState("");

  // Blocca scroll su mobile quando modale aperto
  useEffect(() => {
    document.body.style.overflow = activeInput && isMobile ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [activeInput, isMobile]);

  if (!form) return null;

  const isFormEmpty =
    !form.localitaOrigine &&
    !form.localitaDestinazione &&
    !form.start_datetimeUserEntered &&
    !form.posti_richiestiUserEntered;

  /* ================= DESKTOP FIELD ================= */
  const DesktopField = ({ label, value, icon, onClick, isActive }: any) => (
    <motion.div
      whileHover={{ backgroundColor: "#f8fafc" }}
      transition={{ duration: 0.2 }}
      onClick={onClick}
      className={`
        flex flex-col justify-center items-start px-4 py-2 cursor-pointer rounded-md
        border-2 ${isActive ? "border-[#ff3036] shadow-md" : "border-black/80"}
        min-w-[120px] max-w-[160px] transition-all duration-200
      `}
    >
      <div className="flex items-center gap-1 mb-0.5">
        <div className="text-[#ff3036] text-base">{icon}</div>
        <span className="text-[8px] uppercase tracking-wider text-slate-500">{label}</span>
      </div>
      <span className="text-sm font-medium text-slate-800 truncate">{value || "Seleziona"}</span>
    </motion.div>
  );

  /* ================= MOBILE FORM ================= */
  const MobileForm = (
    <div className="w-full max-w-[1280px] mx-auto flex flex-col gap-4 p-4 relative">
      {activeInput === null && isFormEmpty && (
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="w-full mb-4">
          <InfoBox title="Risparmia con le corse condivise!" type="info">
            Condividendo la tua corsa puoi risparmiare fino al
            <span className="font-bold"> 30%</span>.
          </InfoBox>
        </motion.div>
      )}

      <AppInput
        size="lg"
        readOnly
        placeholder="Da dove parti?"
        icon={<FaMapMarkerAlt className="text-[#ff3036]" />}
        value={form.localitaOrigine?.nome ?? ""}
        onClick={() => {
          setActiveInput("origine");
          setLocationQuery(form.localitaOrigine?.nome ?? "");
        }}
      />

      <AppInput
        size="lg"
        readOnly
        placeholder="Dove vai?"
        icon={<FaMapMarkerAlt className="text-[#ff3036]" />}
        value={form.localitaDestinazione?.nome ?? ""}
        onClick={() => {
          setActiveInput("destinazione");
          setLocationQuery(form.localitaDestinazione?.nome ?? "");
        }}
      />

      <AppInput
        size="lg"
        readOnly
        icon={<FaCalendarAlt className="text-[#ff3036]" />}
        value={form.start_datetime ? formatLocaleDate(form.start_datetime) : ""}
        onClick={() => setActiveInput("data")}
      />

      <AppInput
        size="lg"
        readOnly
        placeholder="Passeggeri"
        icon={<FaUser className="text-[#ff3036]" />}
        value={`${form.posti_richiesti ?? 1} ${form.posti_richiesti === 1 ? "passeggero" : "passeggeri"}`}
        onClick={() => setActiveInput("posti")}
      />

      <MobileSearchCta onClick={onSubmit} loading={loading} />

      <AnimatePresence>
        {activeInput && isMobile && (
          <>
            <motion.div
              onClick={() => setActiveInput(null)}
              className="fixed inset-0 bg-black/40 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25 }}
              className="fixed bottom-0 left-0 w-full bg-white rounded-t-2xl z-50 p-6 h-[60vh] flex flex-col"
            >
              <div className="flex-1 overflow-y-auto space-y-4">
                {(activeInput === "origine" || activeInput === "destinazione") && (
                  <LocationSheet
                    open
                    query={locationQuery}
                    setQuery={setLocationQuery}
                    onClose={() => setActiveInput(null)}
                    onSelect={(location: LocationValue) => {
                      if (activeInput === "origine") {
                        dispatch({ type: "SET_ORIGINE", payload: location });
                      } else {
                        dispatch({ type: "SET_DESTINAZIONE", payload: location });
                      }
                      setActiveInput(null);
                    }}
                  />
                )}

                {activeInput === "data" && (
                  <BottomSheetCalendario
                    value={form.start_datetime ?? nowLocalISO()}
                    onChange={(iso) => {
                      dispatch({ type: "SET_DATETIME", payload: iso, userEntered: true });
                      setActiveInput(null);
                    }}
                  />
                )}

                {activeInput === "posti" && (
                  <PostiSelector
                    value={form.posti_richiesti ?? 1}
                    onChange={(v) => {
                      dispatch({ type: "SET_POSTI", payload: v, userEntered: true });
                      setActiveInput(null);
                    }}
                  />
                )}
              </div>

              <button
                onClick={() => setActiveInput(null)}
                className="w-full bg-[#ff3036] text-white py-4 rounded-xl font-semibold text-lg mt-4"
              >
                Chiudi
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );

  /* ================= DESKTOP FORM ================= */
  const DesktopForm = (
    <div className={`w-full flex justify-center mt-6 ${showResults ? "sticky top-6 z-40" : ""}`}>
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-3">
          <DesktopField
            label="Partenza"
            value={form.localitaOrigine?.nome}
            icon={<FaMapMarkerAlt />}
            isActive={activeInput === "origine"}
            onClick={() => { setActiveInput("origine"); setLocationQuery(form.localitaOrigine?.nome ?? ""); }}
          />

          <DesktopField
            label="Destinazione"
            value={form.localitaDestinazione?.nome}
            icon={<FaMapMarkerAlt />}
            isActive={activeInput === "destinazione"}
            onClick={() => { setActiveInput("destinazione"); setLocationQuery(form.localitaDestinazione?.nome ?? ""); }}
          />

          <DesktopCalendar
            value={form.start_datetime ?? nowLocalISO()}
            onChange={(iso) => dispatch({ type: "SET_DATETIME", payload: iso, userEntered: true })}
            isActive={activeInput === "data"}
            onClick={() => setActiveInput("data")}
          />

          <DesktopField
            label="Passeggeri"
            value={`${form.posti_richiesti ?? 1}`}
            icon={<FaUser />}
            isActive={activeInput === "posti"}
            onClick={() => setActiveInput("posti")}
          />

          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={onSubmit}
            className="px-4 py-2 bg-[#ff3036] hover:bg-[#e02a2f] text-white font-semibold rounded-md text-sm"
          >
            {loading ? "Caricamento..." : "Cerca"}
          </motion.button>
        </div>

        <AnimatePresence>
          {activeInput && (activeInput === "origine" || activeInput === "destinazione" || activeInput === "posti") && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="w-[420px] bg-white rounded-xl shadow-2xl border border-slate-200 p-4 z-50"
            >
              {(activeInput === "origine" || activeInput === "destinazione") && (
                <LocationSheet
                  open
                  query={locationQuery}
                  setQuery={setLocationQuery}
                  onClose={() => setActiveInput(null)}
                  onSelect={(location: LocationValue) => {
                    if (activeInput === "origine") {
                      dispatch({ type: "SET_ORIGINE", payload: location });
                      setActiveInput("destinazione");
                    } else {
                      dispatch({ type: "SET_DESTINAZIONE", payload: location });
                      setActiveInput("posti");
                    }
                  }}
                />
              )}

              {activeInput === "posti" && (
                <PostiSelector
                  value={form.posti_richiesti ?? 1}
                  onChange={(v) => {
                    dispatch({ type: "SET_POSTI", payload: v, userEntered: true });
                    setActiveInput(null);
                  }}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );

  return <>{isMobile ? MobileForm : DesktopForm}</>;
}