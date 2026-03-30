interface Props {
  totalDevices: number;
  totalSizeGB: number;
  totalMessages: number;
  totalExports: number;
}

export default function DataSummaryStrip({ totalDevices, totalSizeGB, totalMessages, totalExports }: Props) {
  const metrics = [
    { value: totalDevices, label: 'Devices' },
    { value: `${totalSizeGB.toFixed(1)} GB`, label: 'Extracted' },
    { value: totalMessages.toLocaleString(), label: 'Messages' },
    { value: totalExports, label: 'Exports' },
  ];

  return (
    <div className="grid grid-cols-4 gap-2 mb-5">
      {metrics.map((m) => (
        <div key={m.label} className="bg-gray-50 rounded-md py-3 px-2.5 text-center">
          <div className="text-xl font-medium text-gray-900">{m.value}</div>
          <div className="text-xs text-gray-400">{m.label}</div>
        </div>
      ))}
    </div>
  );
}
