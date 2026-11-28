import {
  Anchor, BrickWall, ClipboardList, Columns3, DoorOpen, Fan, Flame, Forklift, Grid3x3, Hammer, HardHat, House, Lamp, Layers,
  PaintRoller, Route, Shovel, Sparkles, TrafficCone, TrainTrack, Trees, Truck, Umbrella, WavesHorizontal, Zap, Droplets,
  type LucideIcon,
} from "lucide-react";

const ICONES: Record<string, LucideIcon> = {
  Anchor, BrickWall, ClipboardList, Columns3, DoorOpen, Fan, Flame, Forklift, Grid3x3, Hammer, HardHat, House, Lamp, Layers,
  PaintRoller, Route, Shovel, Sparkles, TrafficCone, TrainTrack, Trees, Truck, Umbrella, WavesHorizontal, Zap, Droplets,
};

/** Ícone do assunto pelo nome gravado no banco; nome desconhecido usa o ícone de camadas. */
export function IconeAssunto({ nome, className }: { nome: string; className?: string }) {
  const I = ICONES[nome] ?? Layers;
  return <I className={className} aria-hidden="true" />;
}

/**
 * Foto real que identifica o assunto ou o serviço; sem foto, o ícone ocupa o mesmo espaço.
 * Usa <img> simples: as fotos já são pequenas (até 640 px) e servidas de /public.
 */
export function FotoOuIcone({ src, icone, alt, className }: { src: string | null; icone: string; alt: string; className?: string }) {
  return (
    <span className={`foto-obra ${src ? "" : "foto-obra-icone"} ${className ?? ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt={alt} loading="lazy" decoding="async" /> : <IconeAssunto nome={icone} />}
    </span>
  );
}
