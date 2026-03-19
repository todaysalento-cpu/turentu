'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const MapLive = dynamic(() => import('./MapLive'), { ssr: false })

function Card({ title, value }: { title: string; value: any }) {
  return (
    <div className="bg-white p-4 rounded shadow flex flex-col items-center justify-center text-center">
      <p className="text-gray-500 text-sm">{title}</p>
      <p className="text-2xl font-bold mt-1">{value ?? '-'}</p>
    </div>
  )
}

export default function AdminDashboardPRO() {
  const [data, setData] = useState<any>({
    clienti: 0,
    autisti: 0,
    veicoli: 0,
    veicoli_disponibili: 0,
    corse_totali: 0,
    corse_oggi: 0,
    fatturato: 0,
    guadagno: 0,
    prezzo_medio_corsa: 0,
    guadagno_medio_autista: 0,
    crescita: [],
    top_autisti: [],
    corse: [],
    autisti_live: []
  })

  const [ultimeCorse, setUltimeCorse] = useState<any[]>([])
  const [ultimiPagamenti, setUltimiPagamenti] = useState<any[]>([])
  const [showCorse, setShowCorse] = useState(true)
  const [showAutisti, setShowAutisti] = useState(true)

  const API_BASE = 'http://localhost:3001'

  const fetchData = async () => {
    try {
      const [dashRes, liveRes, corseRes, pagRes] = await Promise.all([
        fetch(`${API_BASE}/admin/dashboard`, { credentials: 'include' }),
        fetch(`${API_BASE}/admin/live`, { credentials: 'include' }),
        fetch(`${API_BASE}/admin/ultime-corse`, { credentials: 'include' }),
        fetch(`${API_BASE}/admin/ultimi-pagamenti`, { credentials: 'include' })
      ])

      const [dash, liveData, corseData, pagData] = await Promise.all([
        dashRes.json(),
        liveRes.ok ? liveRes.json() : { corse: [], autisti: [] },
        corseRes.json(),
        pagRes.json()
      ])

      // ================= CALCOLI =================
      const corseTotali = dash.corse_totali || 0
      const autistiTotali = dash.autisti || 0
      const fatturato = dash.fatturato || 0
      const guadagno = dash.guadagno || 0
      const prezzoMedioCorsa = corseTotali ? (fatturato / corseTotali).toFixed(2) : '0.00'
      const guadagnoMedioAutista = autistiTotali ? (guadagno / autistiTotali).toFixed(2) : '0.00'

      setData((prev: any) => ({
        ...prev,
        clienti: dash.clienti ?? prev.clienti,
        autisti: dash.autisti ?? prev.autisti,
        veicoli: dash.veicoli ?? prev.veicoli,
        veicoli_disponibili: dash.veicoli_disponibili ?? prev.veicoli_disponibili,
        corse_totali: corseTotali,
        corse_oggi: dash.corse_oggi || 0,
        fatturato,
        guadagno,
        prezzo_medio_corsa: prezzoMedioCorsa,
        guadagno_medio_autista: guadagnoMedioAutista,
        crescita: dash.crescita || [],
        top_autisti: dash.top_autisti || [],
        corse: liveData.corse || [],
        autisti_live: liveData.autisti || []
      }))

      setUltimeCorse(corseData || [])
      setUltimiPagamenti(pagData || [])
    } catch (err) {
      console.error('Errore fetching dashboard:', err)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-2xl font-bold mb-4">Dashboard Admin</h1>

      {/* ==================== GENERALE ==================== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card title="Clienti" value={data.clienti} />
        <Card title="Autisti" value={data.autisti} />
        <Card title="Veicoli totali" value={data.veicoli} />
        <Card title="Veicoli disponibili" value={data.veicoli_disponibili} />
      </div>

      {/* ==================== CORSE ==================== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card title="Corse totali" value={data.corse_totali} />
        <Card title="Corse oggi" value={data.corse_oggi} />
        <Card title="Fatturato" value={`€${data.fatturato}`} />
        <Card title="Guadagno" value={`€${data.guadagno}`} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card title="€/Corsa medio" value={`€${data.prezzo_medio_corsa}`} />
        <Card title="€/Autista medio" value={`€${data.guadagno_medio_autista}`} />
      </div>

      {/* ==================== GRAFICO CRESCITA ==================== */}
      <div className="bg-white p-6 rounded shadow mb-6">
        <h2 className="font-bold mb-4">Crescita ultimi 7 giorni</h2>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.crescita || []}>
            <XAxis dataKey="giorno" />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="ricavi" stroke="#2563eb" strokeWidth={3} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ==================== TOP AUTISTI ==================== */}
      <div className="bg-white p-6 rounded shadow overflow-x-auto mb-6">
        <h2 className="font-bold mb-4">Top Autisti</h2>
        <table className="w-full text-left">
          <thead>
            <tr className="border-b bg-gray-100">
              <th className="px-2 py-1">Autista</th>
              <th className="px-2 py-1">Corse</th>
              <th className="px-2 py-1">Guadagno</th>
            </tr>
          </thead>
          <tbody>
            {(data.top_autisti || []).map((a: any, i: number) => (
              <tr key={i} className="border-b hover:bg-gray-50">
                <td className="px-2 py-1">{a.nome}</td>
                <td className="px-2 py-1 font-semibold">{a.corse}</td>
                <td className="px-2 py-1 font-semibold">€{a.guadagno}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ==================== MAPPA ==================== */}
      <div className="flex gap-4 mb-4">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showCorse} onChange={() => setShowCorse(!showCorse)} />
          Corse attive
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showAutisti} onChange={() => setShowAutisti(!showAutisti)} />
          Autisti disponibili
        </label>
      </div>
      <div className="w-full h-[600px] rounded shadow overflow-hidden mb-6">
        <MapLive
          corse={data.corse}
          autisti={data.autisti_live}
          showCorse={showCorse}
          showAutisti={showAutisti}
        />
      </div>

      {/* ==================== ULTIME CORSE ==================== */}
      <div className="bg-white p-6 rounded shadow overflow-x-auto mb-6">
        <h2 className="font-bold mb-4">Ultime Corse</h2>
        <table className="w-full text-left border">
          <thead>
            <tr className="border-b bg-gray-100">
              <th className="px-2 py-1">ID</th>
              <th className="px-2 py-1">Cliente</th>
              <th className="px-2 py-1">Autista</th>
              <th className="px-2 py-1">Prezzo</th>
              <th className="px-2 py-1">Stato</th>
              <th className="px-2 py-1">Data</th>
            </tr>
          </thead>
          <tbody>
            {ultimeCorse.map(c => (
              <tr key={c.id} className="border-b hover:bg-gray-50">
                <td className="px-2 py-1">{c.id}</td>
                <td className="px-2 py-1">{c.cliente}</td>
                <td className="px-2 py-1">{c.autista}</td>
                <td className="px-2 py-1">€{c.prezzo}</td>
                <td className="px-2 py-1">{c.stato}</td>
                <td className="px-2 py-1">{new Date(c.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ==================== ULTIMI PAGAMENTI ==================== */}
      <div className="bg-white p-6 rounded shadow overflow-x-auto mb-6">
        <h2 className="font-bold mb-4">Ultimi Pagamenti</h2>
        <table className="w-full text-left border">
          <thead>
            <tr className="border-b bg-gray-100">
              <th className="px-2 py-1">ID</th>
              <th className="px-2 py-1">Cliente</th>
              <th className="px-2 py-1">Prezzo</th>
              <th className="px-2 py-1">Commissione</th>
              <th className="px-2 py-1">Guadagno Autista</th>
              <th className="px-2 py-1">Stato</th>
              <th className="px-2 py-1">Data</th>
            </tr>
          </thead>
          <tbody>
            {ultimiPagamenti.map(p => (
              <tr key={p.id} className="border-b hover:bg-gray-50">
                <td className="px-2 py-1">{p.id}</td>
                <td className="px-2 py-1">{p.cliente}</td>
                <td className="px-2 py-1">€{p.prezzo_totale}</td>
                <td className="px-2 py-1">{p.commissione ? `€${p.commissione}` : '-'}</td>
                <td className="px-2 py-1">{p.guadagno_autista ? `€${p.guadagno_autista}` : '-'}</td>
                <td className="px-2 py-1">{p.stato_pagamento}</td>
                <td className="px-2 py-1">{new Date(p.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}