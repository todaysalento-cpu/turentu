'use client';

import { useState, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { loadStripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { FaArrowLeft } from "react-icons/fa";

import BookingCard from "./BookingCard";
import StepDettagli from "./steps/StepDettagli";
import StepPagamentoCard, { Slot } from "./steps/StepPagamento";
import RisultatiSelection from "./RisultatiSelection";
import ActionButton from "./ActionButton";
import StepCondivisione from "./steps/StepCondivisione";
import { useUser } from "../context/UserContext";
import { FiltroSlot } from "../app/page";

interface Coord { lat: number; lon: number; }

interface Props {
  open: boolean;
  type: 'prenota' | 'richiedi';
  onClose: () => void;
  risultati?: any[];
  localitaOrigine?: string;
  localitaDestinazione?: string;
  datetime?: string;
  posti?: number;
  coordOrigine?: Coord;
  coordDestinazione?: Coord;
}

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

export default function BookingFlow({
  open,
  type,
  onClose,
  risultati = [],
  localitaOrigine,
  localitaDestinazione,
  datetime = new Date().toISOString(),
  posti = 1,
  coordOrigine,
  coordDestinazione
}: Props) {

  const { user } = useUser();
  const paymentRef = useRef<{ handlePayment: () => void }>(null);

  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [loadingPayment, setLoadingPayment] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [filtroSlot, setFiltroSlot] = useState<FiltroSlot>("Liberi");
  const [condivisibile, setCondivisibile] = useState<boolean | null>(null);

  const risultatiMappati = useMemo(() =>
    risultati.map(r => ({
      id: r.id?.toString() ?? r.veicolo_id?.toString() ?? Math.random().toString(),
      oraPartenza: r.oraPartenza ?? r.start_datetime,
      oraArrivo: r.oraArrivo ?? r.end_datetime,
      localitaOrigine: r.localitaOrigine ?? r.origine?.nome ?? localitaOrigine ?? "Sconosciuta",
      localitaDestinazione: r.localitaDestinazione ?? r.destinazione?.nome ?? localitaDestinazione ?? "Sconosciuta",
      modello: r.modello ?? "N/D",
      prezzo: r.prezzo ?? 0,
      imageUrl: r.imageUrl?.trim() !== "" ? r.imageUrl : null,
      servizi: r.servizi ?? [],
      veicolo_id: r.veicolo_id,
      durataMinuti: r.durataMinuti ?? Math.floor((r.durataMs ?? 1800000) / 60000),
      coordOrigine: r.coordOrigine ?? coordOrigine,
      coordDestinazione: r.coordDestinazione ?? coordDestinazione,
      postiRichiesti: r.postiRichiesti ?? posti,
      distanza: r.distanza ?? r.distanzaKm ?? 0,
      pending_id: r.pending_id ?? null,
      postiTotali: r.postiTotali ?? 4,
      stato: r.stato ?? "libero",
    })),
    [risultati, coordOrigine, coordDestinazione, localitaOrigine, localitaDestinazione, posti]
  );

  const risultatiSelezionati = risultatiMappati.filter(r => selectedIds.includes(r.id));

  const preparedSlots: Slot[] = useMemo(() =>
    risultatiSelezionati.map(r => ({
      veicolo_id: r.veicolo_id,
      start_datetime: r.oraPartenza ?? datetime,
      durata_minuti: r.durataMinuti,
      posti_richiesti: r.postiRichiesti,
      origine: r.coordOrigine ?? coordOrigine!,
      destinazione: r.coordDestinazione ?? coordDestinazione!,
      localitaOrigine: r.localitaOrigine,
      localitaDestinazione: r.localitaDestinazione,
      distanza: r.distanza,
      pending_id: r.pending_id,
      posti_totali: r.postiTotali,
    })),
    [risultatiSelezionati, coordOrigine, coordDestinazione, datetime]
  );

  const prezzoAutorizzazione = risultatiSelezionati.length
    ? Math.max(...risultatiSelezionati.map(r => r.prezzo))
    : 0;

  // ======================== STEP FLOW ========================
  const steps = [
    {
      render: () => (
        <RisultatiSelection
          risultati={risultatiMappati}
          filtroSlot={filtroSlot}
          setFiltroSlot={setFiltroSlot}
          selectedIds={selectedIds}
          onSelect={id =>
            setSelectedIds(prev =>
              prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
            )
          }
          isMobile
        />
      ),
      footer: selectedIds.length > 0 && (
        <ActionButton
          filtroSlot={filtroSlot}
          selectedIds={selectedIds}
          onAction={() => setStep(1)}
        />
      )
    },
    {
      render: () => (
        <StepDettagli
          type={type}
          risultatiSelezionati={risultatiSelezionati}
          localitaOrigine={localitaOrigine}
          localitaDestinazione={localitaDestinazione}
          datetime={datetime}
          posti={posti}
          onRemoveSlot={id => setSelectedIds(prev => prev.filter(x => x !== id))}
        />
      ),
      footer: (
        <button
          className="w-full h-12 bg-[#ff3036] text-white rounded-lg font-semibold"
          onClick={() => setStep(prev => prev + 1)}
        >
          Conferma dettagli
        </button>
      )
    },
    ...(type === "prenota"
      ? [
          {
            render: () => (
              <StepCondivisione
                condivisibile={condivisibile}
                setCondivisibile={setCondivisibile}
              />
            ),
            footer: (
              <button
                disabled={condivisibile === null}
                className="w-full h-12 bg-[#ff3036] text-white rounded-lg font-semibold disabled:opacity-50"
                onClick={() => setStep(prev => prev + 1)}
              >
                Continua
              </button>
            )
          }
        ]
      : []),
    {
      render: () => (
        <StepPagamentoCard
          ref={paymentRef}
          type={type}
          prezzo={prezzoAutorizzazione}
          slots={preparedSlots}
          loading={loadingPayment}
          setLoading={setLoadingPayment}
          onConfirmSuccess={() => setConfirmed(true)}
        />
      ),
      footer: (
        <button
          className="w-full h-12 bg-[#ff3036] text-white rounded-lg font-semibold"
          onClick={() => paymentRef.current?.handlePayment()}
          disabled={loadingPayment}
        >
          {loadingPayment ? "⏳ Elaborazione..." : "Autorizza e paga"}
        </button>
      )
    }
  ];

  const safeStep = Math.min(step, steps.length - 1);
  const currentStep = steps[safeStep];

  return (
    <Elements stripe={stripePromise}>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 bg-black/50 z-40"
              onClick={onClose}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.div
              className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-2 md:p-4"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25 }}
            >
              <BookingCard
                onClose={onClose}
                className="h-[600px] w-full md:w-3/4 lg:w-1/2 flex flex-col overflow-hidden rounded-t-lg"
                header={
                  !confirmed && (
                    <div className="flex items-center justify-between px-3 py-2">
                      <button
                        onClick={safeStep === 0 ? onClose : () => setStep(prev => prev - 1)}
                        className="text-gray-700 hover:text-[#ff3036]"
                      >
                        <FaArrowLeft size={18} />
                      </button>
                      <div className="flex-1 flex justify-center gap-2">
                        {steps.map((_, i) => (
                          <div
                            key={i}
                            className={`h-2 w-2 rounded-full ${
                              safeStep >= i ? "bg-[#ff3036]" : "bg-gray-300"
                            }`}
                          />
                        ))}
                      </div>
                      <div className="w-5" />
                    </div>
                  )
                }
                footer={<div className="p-2">{currentStep.footer}</div>}
              >
                <div className="flex-1 overflow-y-auto">
                  {confirmed ? (
                    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
                      <h2 className="text-2xl font-bold mb-4">
                        {type === "prenota" ? "Prenotazione completata!" : "Richiesta inviata!"}
                      </h2>
                    </div>
                  ) : (
                    currentStep.render()
                  )}
                </div>
              </BookingCard>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Elements>
  );
}