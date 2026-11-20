/**
 * Monochrome pixel-pig brand silhouette derived verbatim from resources/icon.svg's 18x14 pig grid,
 * merged into a single even-odd contour path so eye and nostril cutouts stay crisp at every scale.
 */
import { cn } from '../../lib/utils'

const PIG_SILHOUETTE_PATH =
  'M6 0H8V1H9V2H10V1H11V0H13V1H14V3H15V4H16V6H17V7H18V10H17V11H16V12H14V13H13V12H11V13H5V14H3V13H2V11H1V10H0V5H1V4H2V3H3V2H5V1H6ZM11 4H10V5H11ZM13 8H12V10H13ZM15 8H14V10H15ZM11 13H13V14H11Z'

export function BotPigIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 18 14"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <path fill="currentColor" fillRule="evenodd" d={PIG_SILHOUETTE_PATH} />
    </svg>
  )
}
