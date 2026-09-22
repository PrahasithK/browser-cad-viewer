import * as THREE from 'three';

const BODY_PALETTE = [
  '#5b9bd5', '#ed7d31', '#70ad47', '#ffc000',
  '#a5a5a5', '#264478', '#9e480e', '#636363'
];

export function randomBodyColor(index: number): string {
  return BODY_PALETTE[index % BODY_PALETTE.length];
}

export function hexToThreeColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

export function contrastingTextColor(hex: string): string {
  const c = new THREE.Color(hex);
  const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return luminance > 0.55 ? '#1a1a1a' : '#f5f5f5';
}
