'use client';

import { useState, useEffect, useRef } from "react";
import { FaUser, FaMapMarkerAlt, FaCalendarAlt } from "react-icons/fa";
import { motion, AnimatePresence } from "framer-motion";
import PostiSelector from "./PostiSelector";
import MobileSearchCta from "./MobileSearchCTA";
import LocationSheet from "./LocationSheet";
import AppInput from "./ui/appInput";
import InfoBox from "./BoxInformativo";
import DesktopCalendar from "./CalendarioDesktop";
import BottomSheetCalendario from "./BottomSheetCalendario";
import BookingCard from "./BookingCard";
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

const nowLocalISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
};

export const formatLocaleDate = (iso: string) => {
  if (!iso) return "N/D";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "N/D";
  return `${d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" })} - ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
};

export default function SearchForm({ form, dispatch, onSubmit, loading, isMobile, showResults = false }: SearchFormProps) {
  const [activeInput, setActiveInput] = useState<ActiveInput>(null);
  const [queryOrigine, setQueryOrigine] = useState("");
  const [queryDestinazione, setQueryDestinazione] = useState("");
  const [locationKey, setLocationKey] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  // Blocca scroll body su mobile quando il pannello è aperto
  useEffect(() => {
    document.body.style.overflow = activeInput && isMobile ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [activeInput, isMobile]);

  // Click fuori pannello
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setActiveInput(null);
    };
    if (activeInput) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [activeInput]);

  if (!form) return null;

  const isFormEmpty = !form.localitaOrigine && !form.localitaDestinazione && !form.start_datetimeUserEntered && !form.posti_richiestiUserEntered;

  // 🔹 Classi comuni
  const inputClasses = "text-sm font-medium text-slate-800 truncate";
  const fieldWrapperClasses = "flex flex-col justify-center items-start px-4 py-2 cursor-pointer rounded-md min-w-[160px] max-w-[200px] transition-all duration-200";
  const fieldActiveBorder = "border-2 border-[#ff3036]";
  const fieldInactiveBorder = "border-2 border-black/80";
  const bottomSheetPanel = "fixed bottom-0 left-0 w-full rounded-t-2xl z-50 p-6 h-[60vh] flex flex-col bg-white dark:bg-gray-800 relative";
  const desktopPanel = "absolute top-full mt-2 w-[420px] rounded-xl border border-slate-200 p-4 z-50 bg-white dark:bg-gray-800";

  const DesktopField = ({ label, value, icon, onClick, isActive, placeholder }: any) => (
    <motion.div
      whileHover={{ backgroundColor: "#f8fafc" }}
      transition={{ duration: 0.2 }}
      onClick={onClick}
      className={`${fieldWrapperClasses} ${isActive ? fieldActiveBorder : fieldInactiveBorder}`}
    >
      <div className="flex items-center gap-1 mb-0.5">
        <div className="text-[#ff3036] text-base">{icon}</div>
        <span className="text-[8px] uppercase tracking-wider text-slate-500">{label}</span>
      </div>
      <span className={inputClasses}>{value || placeholder}</span>
    </motion.div>
  );

  const openField = (field: ActiveInput, queryVal: string) => {
    setActiveInput(field);
    if (field === "origine") setQueryOrigine(queryVal);
    if (field === "destinazione") setQueryDestinazione(queryVal);
    setLocationKey(prev => prev + 1);
  };

  /* ================= MOBILE FORM FULL WIDTH ================= */
  const MobileForm = (
    <div className="w-full flex flex-col gap-4 relative">
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
        value={form.localitaOrigine?.nome ?? queryOrigine}
        onClick={() => openField("origine", form.localitaOrigine?.nome ?? "")}
      />

      <AppInput
        size="lg"
        readOnly
        placeholder="Dove vuoi andare?"
        icon={<FaMapMarkerAlt className="text-[#ff3036]" />}
        value={form.localitaDestinazione?.nome ?? queryDestinazione}
        onClick={() => openField("destinazione", form.localitaDestinazione?.nome ?? "")}
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

      {/* ================= MOBILE FORM FULL WIDTH + BOOKINGCARD ================= */}
      <AnimatePresence>
        {activeInput && isMobile && (
          <motion.div
            className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-0"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 150 }}
          >
            <BookingCard
              show={true}
              className="w-full h-[60vh] flex flex-col px-6 py-6 shadow-xl rounded-t-2xl"
              onClose={() => setActiveInput(null)}
            >
              <div className="flex-1 overflow-y-auto space-y-4 pt-2">
                {(activeInput === "origine" || activeInput === "destinazione") && (
                  <LocationSheet
                    key={locationKey} 
                    query={activeInput === "origine" ? queryOrigine : queryDestinazione}
                    setQuery={activeInput === "origine" ? setQueryOrigine : setQueryDestinazione}
                    isDestinazione={activeInput === "destinazione"}
                    onClose={() => setActiveInput(null)}
                    onSelect={(location: LocationValue) => {
                      if (activeInput === "origine") {
                        dispatch({ type: "SET_ORIGINE", payload: location });
                        setQueryOrigine(location.nome);
                        openField("destinazione", location.nome);
                      } else {
                        dispatch({ type: "SET_DESTINAZIONE", payload: location });
                        setQueryDestinazione(location.nome);
                        setActiveInput("posti");
                      }
                    }}
                  />
                )}

                {activeInput === "data" && (
                  <BottomSheetCalendario
                    value={form.start_datetime ?? ""}
                    onConfirm={(iso) => {
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
            </BookingCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  /* ================= DESKTOP FORM ================= */
  const DesktopForm = (
    <div className={`w-full flex justify-center mt-6 ${showResults ? "sticky top-6 z-40" : ""}`}>
      <div className="flex flex-col items-center gap-3">
        {isFormEmpty && activeInput === null && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="w-full mb-4 max-w-[960px]">
            <InfoBox title="Risparmia con le corse condivise!" type="info">
              Condividendo la tua corsa puoi risparmiare fino al
              <span className="font-bold"> 30%</span>.
            </InfoBox>
          </motion.div>
        )}

        <div className="flex items-center gap-3">
          <DesktopField
            label="Partenza"
            placeholder="Da dove parti?"
            value={form.localitaOrigine?.nome ?? queryOrigine}
            icon={<FaMapMarkerAlt />}
            isActive={activeInput === "origine"}
            onClick={() => openField("origine", form.localitaOrigine?.nome ?? "")}
          />

          <DesktopField
            label="Destinazione"
            placeholder="Dove vuoi andare?"
            value={form.localitaDestinazione?.nome ?? queryDestinazione}
            icon={<FaMapMarkerAlt />}
            isActive={activeInput === "destinazione"}
            onClick={() => openField("destinazione", form.localitaDestinazione?.nome ?? "")}
          />

          <DesktopCalendar
            value={form.start_datetime ?? nowLocalISO()}
            onChange={(iso) => dispatch({ type: "SET_DATETIME", payload: iso, userEntered: true })}
            isActive={activeInput === "data"}
            onClick={() => setActiveInput("data")}
          />

          <DesktopField
            label="Passeggeri"
            placeholder="Quanti passeggeri?"
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
          {activeInput && ["origine", "destinazione", "posti"].includes(activeInput) && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className={desktopPanel}
            >
              {["origine", "destinazione"].includes(activeInput) && (
                <LocationSheet
                  key={locationKey}
                  query={activeInput === "origine" ? queryOrigine : queryDestinazione}
                  setQuery={activeInput === "origine" ? setQueryOrigine : setQueryDestinazione}
                  isDestinazione={activeInput === "destinazione"}
                  onClose={() => setActiveInput(null)}
                  onSelect={(location: LocationValue) => {
                    if (activeInput === "origine") {
                      dispatch({ type: "SET_ORIGINE", payload: location });
                      setQueryOrigine(location.nome);
                      openField("destinazione", location.nome);
                    } else {
                      dispatch({ type: "SET_DESTINAZIONE", payload: location });
                      setQueryDestinazione(location.nome);
                      setActiveInput("posti");
                    }
                  }}
                />
              )}

              {activeInput === "posti" && (
                <PostiSelector
                  value={form.posti_richiesti ?? 1}
                  onChange={(v) => dispatch({ type: "SET_POSTI", payload: v, userEntered: true })}
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