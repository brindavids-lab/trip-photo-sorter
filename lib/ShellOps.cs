// Copies and deletes files on a phone (MTP / "Portable Device") through the
// Windows Shell's IFileOperation, the same engine File Explorer uses.
// Phones are not normal drives, so System.IO cannot reach them.
// Also: the folder picker used by "sort a folder that's already on this laptop".
using System;
using System.Runtime.InteropServices;

namespace TripSorter
{
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOperation
    {
        uint Advise(IntPtr pfops);
        void Unadvise(uint dwCookie);
        void SetOperationFlags(uint dwOperationFlags);
        void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);
        void SetProgressDialog(IntPtr popd);
        void SetProperties(IntPtr pproparray);
        void SetOwnerWindow(IntPtr hwndOwner);
        void ApplyPropertiesToItem(IShellItem psiItem);
        void ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object punkItems);
        void RenameItem(IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IntPtr pfopsItem);
        void RenameItems([MarshalAs(UnmanagedType.IUnknown)] object pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
        void MoveItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IntPtr pfopsItem);
        void MoveItems([MarshalAs(UnmanagedType.IUnknown)] object punkItems, IShellItem psiDestinationFolder);
        void CopyItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszCopyName, IntPtr pfopsItem);
        void CopyItems([MarshalAs(UnmanagedType.IUnknown)] object punkItems, IShellItem psiDestinationFolder);
        void DeleteItem(IShellItem psiItem, IntPtr pfopsItem);
        void DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object punkItems);
        uint NewItem(IShellItem psiDestinationFolder, uint dwFileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string pszName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, IntPtr pfopsItem);
        void PerformOperations();
        [return: MarshalAs(UnmanagedType.Bool)]
        bool GetAnyOperationsAborted();
    }

    public static class ShellOps
    {
        const uint FOF_NOCONFIRMATION = 0x0010;
        const uint FOF_NOCONFIRMMKDIR = 0x0200;
        const uint FOF_SILENT = 0x0004;
        const uint FOF_NOERRORUI = 0x0400;
        static readonly Guid CLSID_FileOperation = new Guid("3ad05575-8857-4850-9277-11b85bdb8e09");
        static readonly Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            [MarshalAs(UnmanagedType.Interface, IidParameterIndex = 2)] out IShellItem ppv);

        [DllImport("shell32.dll", PreserveSig = false)]
        static extern void SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object punk, out IntPtr ppidl);

        [DllImport("shell32.dll", PreserveSig = false)]
        static extern void SHCreateItemFromIDList(IntPtr pidl,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            [MarshalAs(UnmanagedType.Interface, IidParameterIndex = 1)] out IShellItem ppv);

        // A normal folder on the laptop.
        static IShellItem Item(string path)
        {
            IShellItem item;
            SHCreateItemFromParsingName(path, IntPtr.Zero, IID_IShellItem, out item);
            return item;
        }

        // A Shell.Application FolderItem, e.g. a photo on the phone. Phone items can't be
        // re-opened from their FolderItem.Path text, so go through the item's ID list instead.
        static IShellItem Item(object folderItem)
        {
            IntPtr pidl;
            SHGetIDListFromObject(folderItem, out pidl);
            try
            {
                IShellItem item;
                SHCreateItemFromIDList(pidl, IID_IShellItem, out item);
                return item;
            }
            finally { Marshal.FreeCoTaskMem(pidl); }
        }

        // (IFileOperation.SetProgressMessage is documented as not implemented, so no custom title.)
        // Silent operations show no Windows dialogs at all: the sorter page shows progress, and
        // an error dialog would block the page's local server. Failures are found by checking files.
        static IFileOperation NewOperation(uint flags)
        {
            var op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_FileOperation));
            op.SetOperationFlags(flags | FOF_SILENT | FOF_NOERRORUI);
            return op;
        }

        // Copies each source (a Shell.Application FolderItem on the phone) into the matching
        // destination folder (a normal path that already exists). Returns false if aborted.
        public static bool Copy(object[] sources, string[] destFolders)
        {
            var op = NewOperation(FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR);
            try
            {
                for (int i = 0; i < sources.Length; i++)
                    op.CopyItem(Item(sources[i]), Item(destFolders[i]), null, IntPtr.Zero);
                op.PerformOperations();
                return !op.GetAnyOperationsAborted();
            }
            finally { Marshal.ReleaseComObject(op); }
        }

        // Permanently deletes the given phone files (FolderItems; phones have no Recycle Bin).
        public static bool Delete(object[] items)
        {
            var op = NewOperation(FOF_NOCONFIRMATION);
            try
            {
                foreach (var folderItem in items) op.DeleteItem(Item(folderItem), IntPtr.Zero);
                op.PerformOperations();
                return !op.GetAnyOperationsAborted();
            }
            finally { Marshal.ReleaseComObject(op); }
        }
    }

    // The modern Explorer-style "choose a folder" window (the one "Save as" uses).
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid([In] ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    public static class FolderPicker
    {
        const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        static readonly Guid CLSID_FileOpenDialog = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);

        // Windows stops background programs (like the minimized helper) from jumping in front of the
        // browser, so borrow the browser's input queue for a moment to bring our window forward.
        public static void BringToFront(IntPtr window)
        {
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            uint ourThread = GetCurrentThreadId();
            bool attached = foregroundThread != ourThread && AttachThreadInput(ourThread, foregroundThread, true);
            BringWindowToTop(window);
            SetForegroundWindow(window);
            if (attached) AttachThreadInput(ourThread, foregroundThread, false);
        }

        // Returns the chosen folder's path, or null if the person cancelled.
        public static string Pick(IntPtr owner, string title)
        {
            var dialog = (IFileOpenDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_FileOpenDialog));
            try
            {
                dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                dialog.SetTitle(title);
                dialog.SetOkButtonLabel("Sort this folder");
                if (dialog.Show(owner) != 0) return null;   // cancelled
                IShellItem item;
                dialog.GetResult(out item);
                string path;
                item.GetDisplayName(SIGDN_FILESYSPATH, out path);
                return path;
            }
            finally { Marshal.ReleaseComObject(dialog); }
        }
    }
}