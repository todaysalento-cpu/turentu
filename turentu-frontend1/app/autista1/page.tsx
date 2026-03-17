export default function AutistaPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">Dashboard Autista</h1>
      <p>Gestisci veicoli, disponibilità e prenotazioni.</p>

      {/* Lista veicoli */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="p-4 bg-white dark:bg-zinc-800 rounded shadow flex justify-between items-center">
          <div>
            <h2 className="font-semibold">Veicolo 1</h2>
            <p>Disponibile: Sì</p>
          </div>
          <button className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 transition">
            Accetta Prenotazioni
          </button>
        </div>
        <div className="p-4 bg-white dark:bg-zinc-800 rounded shadow flex justify-between items-center">
          <div>
            <h2 className="font-semibold">Veicolo 2</h2>
            <p>Disponibile: No</p>
          </div>
          <button className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 transition">
            Accetta Prenotazioni
          </button>
        </div>
      </div>

      <button className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition">
        Aggiungi Veicolo
      </button>
    </div>
  );
}
