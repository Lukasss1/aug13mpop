import React from 'react';
import { BRAND, DRIP_PATH, DRIP_VIEWBOX, WAVE_PATH, WAVE_VIEWBOX } from '../brand';

/**
 * Brand section edges, traced 1:1 from the brandbook pattern pages:
 *  - drips ("подтёки") hang from the TOP of a section → richness / creaminess
 *  - the soft wave ("волны") closes the BOTTOM of a section → freshness
 * The `type` prop keeps backwards compatibility with previous usages:
 *  'double' | 'single'  → wave band
 *  'wave-top'           → drips hanging into the section below
 */
interface WaveDividerProps {
  color?: string;
  bgColor?: string;
  reverse?: boolean;
  type?: 'single' | 'double' | 'complex' | 'wave-bottom' | 'wave-top' | 'drips';
  className?: string;
}

export const WaveDivider: React.FC<WaveDividerProps> = ({
  color = BRAND.caramel,
  bgColor = BRAND.white,
  reverse = false,
  type = 'double',
  className = ''
}) => {
  const isDrip = type === 'wave-top' || type === 'drips';
  const viewBox = isDrip ? DRIP_VIEWBOX : WAVE_VIEWBOX;
  const path = isDrip ? DRIP_PATH : WAVE_PATH;
  const fill = isDrip ? (type === 'wave-top' ? bgColor : color) : color;

  return (
    <div className={`relative w-full overflow-hidden leading-[0] ${className}`}>
      <svg
        viewBox={viewBox}
        preserveAspectRatio="none"
        className={`relative block w-full ${isDrip ? 'h-[52px]' : 'h-[40px]'}`}
        style={{ transform: reverse ? 'rotate(180deg)' : 'none' }}
        aria-hidden="true"
      >
        <path d={path} fill={fill} />
      </svg>
    </div>
  );
};
