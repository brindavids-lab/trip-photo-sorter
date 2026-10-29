// Copies and deletes files on a phone (MTP / "Portable Device") through the
// Windows Shell's IFileOperation, the same engine File Explorer uses.
// Phones are not normal drives, so System.IO cannot reach them.
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
        static readonly Guid CLSID_FileOperation = new Guid("3ad05575-8857-4850-9277-11b85bdb8e09");
        static readonly Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            [MarshalAs(UnmanagedType.Interface, IidParameterIndex = 2)] out IShellItem ppv);

        static IShellItem Item(string parsingName)
        {
            IShellItem item;
            SHCreateItemFromParsingName(parsingName, IntPtr.Zero, IID_IShellItem, out item);
            return item;
        }

        static IFileOperation NewOperation(uint flags, string message)
        {
            var op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_FileOperation));
            op.SetOperationFlags(flags);
            if (!string.IsNullOrEmpty(message)) op.SetProgressMessage(message);
            return op;
        }

        // Copies each source (a shell parsing name, e.g. FolderItem.Path of a phone file)
        // into the matching destination folder (a normal path that already exists).
        // Shows the Windows progress dialog. Returns false if the user cancelled.
        public static bool Copy(string[] sources, string[] destFolders)
        {
            var op = NewOperation(FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR, "Copying trip photos from your phone");
            try
            {
                for (int i = 0; i < sources.Length; i++)
                    op.CopyItem(Item(sources[i]), Item(destFolders[i]), null, IntPtr.Zero);
                op.PerformOperations();
                return !op.GetAnyOperationsAborted();
            }
            finally { Marshal.ReleaseComObject(op); }
        }

        // Permanently deletes the given phone files (phones have no Recycle Bin).
        public static bool Delete(string[] items)
        {
            var op = NewOperation(FOF_NOCONFIRMATION, "Deleting sorted photos from your phone");
            try
            {
                foreach (var path in items) op.DeleteItem(Item(path), IntPtr.Zero);
                op.PerformOperations();
                return !op.GetAnyOperationsAborted();
            }
            finally { Marshal.ReleaseComObject(op); }
        }
    }
}
