// The only module that imports echarts. It is loaded with import() so it lands in its own chunk
// and the main bundle never pays for it.
import { use, init } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

export { init }
export type { EChartsType, EChartsCoreOption } from 'echarts/core'
