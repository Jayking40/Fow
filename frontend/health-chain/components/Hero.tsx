import Image from "next/image";

export default function Hero() {
  return (
    <section className="relative w-full min-h-[700px] md:min-h-[900px] bg-surface overflow-hidden">
      
      {/* Blood Drop: Centered on mobile, Left-positioned on Desktop */}
      <div className="absolute top-[-50px] left-[100px] -translate-x-1/2 md:translate-x-0 md:top-[-75px] md:left-[-150px] xl:left-[-250px] z-0 pointer-events-none w-[90vw] md:w-[55vw] md:min-w-[800px] h-[600px] md:h-[897px]">
        <Image 
            src="/blood-drop.png" 
            alt="Blood Drop Background" 
            fill
            className="object-contain object-top md:object-left-top drop-shadow-[0px_4px_4px_rgba(0,0,0,0.25)]"
            priority
        />
      </div>

      {/* Hero Content: Centered Mobile, Right Desktop */}
      <div className="absolute top-[400px] md:top-[378px] w-full md:right-[5%] xl:right-[10%] md:w-auto max-w-full md:max-w-[550px] flex flex-col items-center md:items-end gap-8 md:gap-[42px] z-10 px-6 md:pr-6 md:pl-0 text-center md:text-right">
        
        <h1 className="font-roboto font-bold text-[40px] md:text-[49px] leading-tight md:leading-[56px] tracking-[0.05em] text-text-secondary w-full drop-shadow-[0_2px_10px_rgba(255,255,255,0.9)]">
          Save Life Donate <br /> Blood
        </h1>
        
        <p className="font-roboto font-normal text-[16px] leading-[25px] tracking-[0.05em] text-text-primary w-full md:pl-10 drop-shadow-[0_1px_5px_rgba(255,255,255,0.9)]">
          A community-powered platform that connects people who need blood with donors who care — supported by secure, transparent technology behind the scenes.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-4 md:gap-[29px] justify-center md:justify-end w-full">
          <button className="bg-brand-requestBtn text-[#fffbfb] px-6 py-3 min-w-[150px] h-[49px] rounded shadow hover:opacity-90 transition font-roboto font-semibold text-[16px]">
            Request Blood
          </button>
          
          <button className="bg-brand-loginBtn text-[#fffbfb] px-6 py-3 min-w-[150px] h-[49px] rounded shadow hover:opacity-90 transition font-roboto font-semibold text-[16px]">
            Become A Donor
          </button>
        </div>

      </div>
    </section>
  );
}